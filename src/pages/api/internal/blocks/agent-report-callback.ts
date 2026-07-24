import type { NextApiRequest, NextApiResponse } from 'next';
import type { Readable } from 'node:stream';
import { withAxiom } from '@civitai/next-axiom';
import { isAppBlocksPipelineEnabled } from '~/server/services/app-blocks-flag';
import { verifyAgentCallbackToken } from '~/server/services/blocks/review-session';
import { checkCallbackTimestamp } from './review-build-callback';

/**
 * POST /api/internal/blocks/agent-report-callback  (AGENTIC MOD CODE-REVIEW, P1)
 *
 * The ephemeral review agent pod → civitai-web, once it has produced its report
 * (or definitively failed / hit the cost cap). Clones the review-build-callback
 * shape:
 *   1. Raw-body read with a small cap (bodyParser:false).
 *   2. AUTH via the PER-REVIEW bearer bound to publishRequestId — NOT the shared
 *      HMAC secret (that must never reach the agent pod).
 *   3. Pipeline kill-switch (503 when the global flag is dark).
 *   4. checkCallbackTimestamp replay-freshness window (enforce-if-present).
 *   5. UPDATE the report row WHERE publishRequestId matches AND status is still
 *      `running` (so a torn-down / decided review can't be overwritten — mirrors
 *      the review-build-callback's previewNoLongerActive guard).
 *
 * DARK: gated by the same global `app-blocks-pipeline-enabled` kill-switch as the
 * review-build path; with the feature's mod-visibility flag absent, no agent is
 * ever provisioned to call this in the first place.
 */

// Bearer auth binds the caller; we still read the raw body ourselves to enforce
// a hard size cap independent of Next's body parser.
export const config = {
  api: { bodyParser: false },
};

// Reports carry structured codeReview / securityAudit / scopeVerdicts JSON + a
// markdown summary — larger than the 8KB build callback, but still bounded.
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SUMMARY_CHARS = 100 * 1024;

async function readRawBody(req: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('payload too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

const PUBREQ_RE = /^pubreq_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Runner-reported statuses. All THREE are now valid persisted statuses (the
 *  report table's CHECK allows running|complete|failed|torn-down|cost-capped), so
 *  the runner's outcome — `cost-capped` included — is stored VERBATIM rather than
 *  collapsed onto `failed`; a summary marker still flags the cost-cap for the UI. */
const RUNNER_STATUSES = ['complete', 'failed', 'cost-capped'] as const;
type RunnerStatus = (typeof RUNNER_STATUSES)[number];

type CallbackBody = {
  publishRequestId?: string;
  status?: string;
  model?: unknown;
  codeReview?: unknown;
  securityAudit?: unknown;
  scopeVerdicts?: unknown;
  summaryMd?: unknown;
  tokenUsage?: unknown;
  costUsd?: unknown;
  ts?: unknown;
};

function bearerFrom(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Map a runner status onto the persisted report status — now an IDENTITY: every
 *  runner status (complete|failed|cost-capped) is a valid persisted status, so
 *  `cost-capped` is stored verbatim (no longer collapsed onto `failed`). Kept as
 *  a named seam for the unit test + a single place to intercept if the persisted
 *  set ever diverges from the runner set again. */
export function persistedStatusFor(
  runner: RunnerStatus
): 'complete' | 'failed' | 'cost-capped' {
  return runner;
}

/** Build the report UPDATE `data` from a validated body. Only provided fields are
 *  set (undefined = leave existing). Pure + exported so the field mapping is
 *  unit-tested without the DB. */
export function buildReportUpdate(body: CallbackBody): Record<string, unknown> {
  const runner = body.status as RunnerStatus;
  const data: Record<string, unknown> = {
    status: persistedStatusFor(runner),
    completedAt: new Date(),
  };
  if (typeof body.model === 'string') data.model = body.model.slice(0, 200);
  if (body.codeReview !== undefined && body.codeReview !== null) data.codeReview = body.codeReview;
  if (body.securityAudit !== undefined && body.securityAudit !== null)
    data.securityAudit = body.securityAudit;
  if (body.scopeVerdicts !== undefined && body.scopeVerdicts !== null)
    data.scopeVerdicts = body.scopeVerdicts;
  if (body.tokenUsage !== undefined && body.tokenUsage !== null) data.tokenUsage = body.tokenUsage;
  if (typeof body.costUsd === 'number' && Number.isFinite(body.costUsd) && body.costUsd >= 0)
    data.costUsd = body.costUsd;

  let summary = typeof body.summaryMd === 'string' ? body.summaryMd : '';
  if (runner === 'cost-capped') {
    // Preserve the cost-cap signal that the persisted `failed` status loses.
    summary = `> ⚠️ Review stopped at the cost cap.\n\n${summary}`;
  }
  if (summary) data.summaryMd = summary.slice(0, MAX_SUMMARY_CHARS);

  return data;
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch {
    res.status(413).json({ error: 'Payload too large' });
    return;
  }

  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody.toString('utf8')) as CallbackBody;
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  if (!body.publishRequestId || !PUBREQ_RE.test(body.publishRequestId)) {
    res.status(400).json({ error: 'Invalid publishRequestId' });
    return;
  }

  // AUTH: the per-review bearer bound to THIS publishRequestId. Never the shared
  // HMAC secret.
  const token = bearerFrom(req.headers['authorization']);
  if (!verifyAgentCallbackToken(token, body.publishRequestId).ok) {
    res.status(401).json({ error: 'Bad or missing bearer' });
    return;
  }

  // Pipeline kill-switch — same global flag the build callbacks use.
  if (!(await isAppBlocksPipelineEnabled())) {
    res.status(503).json({ error: 'Apps are not enabled' });
    return;
  }

  // Replay-freshness (enforce-if-present). The bearer's short TTL is the primary
  // replay bound; this tightens it when the runner stamps a `ts`.
  const tsCheck = checkCallbackTimestamp(body.ts);
  if (!tsCheck.ok) {
    res.status(401).json({ error: 'Stale or invalid timestamp' });
    return;
  }

  if (!body.status || !RUNNER_STATUSES.includes(body.status as RunnerStatus)) {
    res.status(400).json({ error: 'status must be one of complete|failed|cost-capped' });
    return;
  }

  const data = buildReportUpdate(body);

  // UPDATE the running report row for this review. `updateMany` + the
  // status='running' guard means a torn-down / decided / already-reported review
  // is a no-op (count 0) — never resurrected, never double-written.
  let updated: number;
  try {
    const { dbWrite } = await import('~/server/db/client');
    const result = await dbWrite.appReviewAgentReport.updateMany({
      where: { publishRequestId: body.publishRequestId, status: 'running' },
      data,
    });
    updated = result.count;
  } catch (e) {
    res.status(500).json({ error: 'Report write failed', detail: String(e).slice(0, 240) });
    return;
  }

  if (updated === 0) {
    res.status(200).json({
      ok: true,
      applied: false,
      reason: 'no running report for this review (torn down, decided, or already reported)',
    });
    return;
  }

  res.status(200).json({ ok: true, applied: true });
});
