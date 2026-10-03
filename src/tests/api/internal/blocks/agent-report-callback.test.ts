import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — POST
 * /api/internal/blocks/agent-report-callback:
 *   - per-review BEARER auth (not the shared HMAC) — bad/missing → 401
 *   - pipeline kill-switch → 503 (dark posture)
 *   - checkCallbackTimestamp replay window (enforce-if-present)
 *   - report shape validation + status passthrough (cost-capped persisted verbatim)
 *   - UPDATE guarded to status='running' — a torn-down/decided review is a no-op
 */

const { mockFlag, mockVerify, mockUpdateMany, mockTs } = vi.hoisted(() => ({
  mockFlag: { enabled: true },
  mockVerify: vi.fn((): { ok: boolean; publishRequestId?: string } => ({
    ok: true,
    publishRequestId: 'x',
  })),
  mockUpdateMany: vi.fn(async (_args: { where: unknown; data: any }) => ({ count: 1 })),
  // Faithful ±300s stand-in for the reused checkCallbackTimestamp.
  mockTs: vi.fn((ts: unknown) => {
    if (ts === undefined || ts === null) return { ok: true };
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, reason: 'bad' };
    return Math.abs(Math.floor(Date.now() / 1000) - ts) > 300
      ? { ok: false, reason: 'skew' }
      : { ok: true };
  }),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksPipelineEnabled: vi.fn(async () => mockFlag.enabled),
}));
vi.mock('~/server/services/blocks/review-session', () => ({
  verifyAgentCallbackToken: mockVerify,
}));
vi.mock('~/pages/api/internal/blocks/review-build-callback', () => ({
  checkCallbackTimestamp: mockTs,
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: { appReviewAgentReport: { updateMany: mockUpdateMany } },
}));

import handler, {
  buildReportUpdate,
  persistedStatusFor,
} from '~/pages/api/internal/blocks/agent-report-callback';
import { AGENT_REVIEW_SECTIONS } from '~/shared/constants/agent-review-section.constants';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

function makeReqRes(body: string, opts: { method?: string; auth?: string } = {}) {
  const stream = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  stream.method = opts.method ?? 'POST';
  (stream as any).headers = { authorization: opts.auth ?? 'Bearer good.token' };
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return {
    req: stream,
    res: res as unknown as NextApiResponse & { statusCode: number; body: any },
  };
}

const goodBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    publishRequestId: PUBREQ,
    status: 'complete',
    model: 'anthropic/claude',
    codeReview: { findings: [] },
    securityAudit: { high: 0 },
    scopeVerdicts: { 'apps:storage': 'ok' },
    summaryMd: '# Looks fine',
    tokenUsage: { input: 10, output: 20 },
    costUsd: 0.42,
    ...over,
  });

beforeEach(() => {
  mockFlag.enabled = true;
  mockVerify.mockReturnValue({ ok: true, publishRequestId: PUBREQ });
  mockUpdateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.clearAllMocks());

describe('persistedStatusFor / buildReportUpdate (pure)', () => {
  it('persists every runner status verbatim (cost-capped no longer collapses to failed)', () => {
    expect(persistedStatusFor('complete')).toBe('complete');
    expect(persistedStatusFor('failed')).toBe('failed');
    expect(persistedStatusFor('cost-capped')).toBe('cost-capped');
  });

  it('writes the provided structured fields + costUsd', () => {
    const data = buildReportUpdate(JSON.parse(goodBody()));
    expect(data).toMatchObject({
      status: 'complete',
      model: 'anthropic/claude',
      codeReview: { findings: [] },
      securityAudit: { high: 0 },
      scopeVerdicts: { 'apps:storage': 'ok' },
      tokenUsage: { input: 10, output: 20 },
      costUsd: 0.42,
    });
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('persists cost-capped verbatim AND prepends a cost-cap marker to the summary', () => {
    const data = buildReportUpdate(JSON.parse(goodBody({ status: 'cost-capped' })));
    expect(data.status).toBe('cost-capped');
    expect(String(data.summaryMd)).toContain('cost cap');
  });

  it('drops a non-finite / negative costUsd', () => {
    expect(buildReportUpdate(JSON.parse(goodBody({ costUsd: -1 }))).costUsd).toBeUndefined();
    expect(buildReportUpdate(JSON.parse(goodBody({ costUsd: 'nope' }))).costUsd).toBeUndefined();
  });

  /**
   * 🔴 SEAM GUARD, NOT A COMPONENT GUARD — the writable section set vs the shared ledger.
   *
   * `AGENT_REVIEW_SECTIONS` now has four consumers (the request schema, the service that
   * builds the job, the renderer, and THIS writer). The writer's divergence is the silent
   * one: a fifth analysis wired through schema + service + UI but missed here would have
   * its results dropped on write, and every one of those surfaces would still test green
   * in isolation. So this pins the RELATIONSHIP — it fails when the set GROWS (a new ledger
   * section the writer ignores) and when it SHRINKS (a key the writer still accepts after
   * the ledger dropped it).
   *
   * The body is built FROM the ledger rather than hand-spelled, which is what makes the
   * growth half automatic. Values are pairwise distinct AND distinct from any literal this
   * file asserts elsewhere, so a writer that hardcoded one key's value cannot survive.
   */
  it('🔴 writes EXACTLY the shared ledger’s section keys — no more, no fewer', () => {
    const marker = (section: string) => ({ from: `ledger:${section}` });
    const body: Record<string, unknown> = {
      publishRequestId: PUBREQ,
      status: 'complete',
      // A section-shaped key the ledger does NOT contain. The negative half: an
      // attacker-or-typo field must not reach the UPDATE `data`, because `data` is
      // handed to Prisma as a column map.
      licenseAudit: { from: 'not-in-ledger' },
    };
    for (const section of AGENT_REVIEW_SECTIONS) body[section] = marker(section);

    const data = buildReportUpdate(body);

    // Growth half: every ledger section is written, with ITS OWN value.
    for (const section of AGENT_REVIEW_SECTIONS) {
      expect(data[section], `ledger section \`${section}\` was not written`).toEqual(
        marker(section)
      );
    }
    // Shrink half: the written section-shaped keys are exactly the ledger's.
    const ledger = new Set<string>(AGENT_REVIEW_SECTIONS);
    const nonSection = new Set([
      'status',
      'completedAt',
      'model',
      'tokenUsage',
      'costUsd',
      'summaryMd',
    ]);
    const writtenSections = Object.keys(data).filter((k) => !nonSection.has(k));
    expect(new Set(writtenSections)).toEqual(ledger);
    expect(data.licenseAudit).toBeUndefined();

    // 🔴 POSITIVE CONTROL — a ledger that had gone empty would satisfy both halves above
    // while asserting nothing. Three is today's count; the bound is what matters.
    expect(AGENT_REVIEW_SECTIONS.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The carry-forward contract a TARGETED re-run depends on: a callback reporting on ONE
   * section must not blank the other two. `startAgentReview` step (d') copies the previous
   * report's untargeted sections forward precisely because this writer leaves an absent
   * key alone — so if that ever became "write null", a one-section retry would erase the
   * two analyses it did not re-run.
   */
  it('🔴 an ABSENT or NULL section is left alone — a one-section retry cannot blank the others', () => {
    const [first, ...rest] = AGENT_REVIEW_SECTIONS;
    const data = buildReportUpdate({
      publishRequestId: PUBREQ,
      status: 'complete',
      [first]: { only: 'this one ran' },
      // An explicit null is the runner's way of saying "no result", and must be treated
      // as absence rather than written as a NULL column value.
      ...(rest[0] ? { [rest[0]]: null } : {}),
    });
    expect(data[first]).toEqual({ only: 'this one ran' });
    for (const section of rest) {
      expect(data, `\`${section}\` must not be written at all`).not.toHaveProperty(section);
    }
    expect(rest.length, 'the fixture needs at least one untargeted section').toBeGreaterThan(0);
  });
});

describe('POST /api/internal/blocks/agent-report-callback', () => {
  it('405 on non-POST', async () => {
    const { req, res } = makeReqRes(goodBody(), { method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('400 on invalid JSON', async () => {
    const { req, res } = makeReqRes('{not json');
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('400 on an invalid publishRequestId', async () => {
    const { req, res } = makeReqRes(goodBody({ publishRequestId: 'nope' }));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('401 on a bad/missing bearer', async () => {
    mockVerify.mockReturnValue({ ok: false });
    const { req, res } = makeReqRes(goodBody(), { auth: 'Bearer wrong' });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('verifies the bearer is bound to the body publishRequestId', async () => {
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(mockVerify).toHaveBeenCalledWith('good.token', PUBREQ);
  });

  it('503 under the pipeline kill-switch (dark)', async () => {
    mockFlag.enabled = false;
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('401 on a stale timestamp', async () => {
    const { req, res } = makeReqRes(goodBody({ ts: 1 }));
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('400 on an unknown status', async () => {
    const { req, res } = makeReqRes(goodBody({ status: 'weird' }));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('200 applied:true — writes the report to the running row', async () => {
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: true });
    const args = mockUpdateMany.mock.calls[0][0];
    expect(args.where).toEqual({ publishRequestId: PUBREQ, status: 'running' });
    expect(args.data.status).toBe('complete');
  });

  it('200 applied:false when there is no running row (torn down / decided)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: false });
  });
});
