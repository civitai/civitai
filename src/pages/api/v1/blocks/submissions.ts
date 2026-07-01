import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import * as z from 'zod';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { dbRead } from '~/server/db/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * GET /api/v1/blocks/submissions
 *
 * TOKEN-AUTHENTICATED, SELF-SCOPED read of the caller's own App-Block publish
 * (submission) requests — review status + Phase-2 deploy lifecycle. This is the
 * server-side surface that unblocks a future `civitai app status` CLI command:
 * a developer who submitted via `civitai app submit`
 * (`POST /api/v1/blocks/submit-version`) can now poll the review/deploy state of
 * THEIR OWN submissions with the SAME token.
 *
 * Today that data lives ONLY behind `blocks.listMyPublishRequests`, a
 * `moderatorProcedure` reachable from a logged-in mod browser but NOT from a
 * headless CLI carrying only a bearer token. This route returns the SAME useful
 * fields, but as a CLI-friendly REST GET and HARD-FILTERED to the caller.
 *
 * ## Auth — mirrors `POST /api/v1/blocks/submit-version` EXACTLY, so the token
 *    that submitted can read status:
 *   - `Authorization: Bearer <civitai API key>` resolved via
 *     `getSessionFromBearerToken` (the same helper backing all `/api/v1/*` REST
 *     auth) — NO new key system.
 *   - A PERSONAL key always passes the token-type gate.
 *   - An OAUTH-client-issued token passes ONLY if it carries the dedicated
 *     `TokenScope.AppBlocksSubmit` bit (the same gate submit-version uses; the
 *     first-party `civitai-cli` client is provisioned with it). An un-scoped
 *     OAuth token → 403. This keeps the read in lockstep with the write: the
 *     same credential that could submit can read its own submissions, and
 *     nothing weaker.
 *   - MOD-ONLY pre-GA (`isAppBlocksEnabled({ user })` + `user.isModerator`,
 *     not banned) — identical posture to submit-version + dev-token. RELAX in
 *     lockstep with the rest of App Blocks at GA, not unilaterally.
 *
 * ## Self-scoping — the security crux
 * Rows are filtered STRICTLY to `submittedByUserId === user.id` (the
 * authenticated caller). There is NO request input that can widen this: the
 * optional `id` / `blockId` query params only NARROW the already-self-scoped set
 * (and an `id` / `blockId` the caller doesn't own resolves to 404, never another
 * user's row). A developer can only ever see their own submissions.
 *
 * ## Why no CSRF / Origin guard (same reasoning as submit-version)
 * Bearer-authed: the credential rides an `Authorization` header a cross-site
 * form can't set and the browser never attaches automatically — no ambient
 * authority, so the Origin guard is intentionally omitted (it would also break
 * the headless CLI, which sends no Origin).
 */
export const config = {
  api: {
    // No request body is read (GET); cap small anyway so a determined caller
    // can't push parse pressure on a stray body.
    bodyParser: { sizeLimit: '8kb' },
  },
};

// A read is cheap; allow generous polling for `civitai app status` while still
// bounding abuse. Per-user fixed window, fail-closed on a malformed limiter.
const RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;

// Mirror listMyPublishRequests' page size.
const MAX_ROWS = 100;

const APPS_DOMAIN_FALLBACK = 'civit.ai';

const querySchema = z.object({
  // OPTIONAL single-submission filter by publish-request id (`pubreq_<ULID>`).
  // NARROWS the already-self-scoped set — never widens it. Not-found / not-owned
  // → 404 (no ownership oracle), exactly like dev-token.
  id: z.string().min(1).max(128).optional(),
  // OPTIONAL filter to a single app's submissions by its slug (block_id). Also
  // strictly within the caller's own rows.
  blockId: z.string().min(1).max(128).optional(),
});

function clientIp(req: NextApiRequest): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  return (first ?? req.socket?.remoteAddress ?? 'unknown').trim();
}

/** Single query-param value (Next gives `string | string[] | undefined`). */
function firstQuery(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

type SubmissionRow = {
  id: string;
  appBlockId: string | null;
  slug: string;
  version: string;
  status: string;
  rejectionReason: string | null;
  approvalNotes: string | null;
  deployState: string | null;
  deployDetail: string | null;
  deployUpdatedAt: Date | null;
  submittedAt: Date;
  reviewedAt: Date | null;
  updatedAt: Date;
};

/**
 * Shape one DB row into the safe, CLI-friendly response. NO internal-only
 * columns (bundleKey/bundleSha256/forgejoCommitSha/manifest/file diffs/reviewer
 * id), and never another user's data (rows are self-scoped at the query).
 *
 * `liveUrl` is the `https://<slug>.civit.ai/` surface, surfaced ONLY once the
 * app is actually serving (deployState 'live', or a legacy null deployState on
 * an approved row — same "assume live" rule as the /apps/my-submissions UI).
 */
function shapeRow(row: SubmissionRow, appsDomain: string) {
  const isApproved = row.status === 'approved';
  const isLive = isApproved && (row.deployState === 'live' || row.deployState == null);
  return {
    id: row.id,
    blockId: row.slug, // the app slug == `block_id` that builds <slug>.civit.ai
    appBlockId: row.appBlockId,
    version: row.version,
    status: row.status, // 'pending' | 'approved' | 'rejected' | 'withdrawn'
    rejectionReason: row.rejectionReason,
    approvalNotes: row.approvalNotes,
    deployState: row.deployState, // null | 'building' | 'deploying' | 'live' | 'failed'
    deployDetail: row.deployDetail,
    deployUpdatedAt: row.deployUpdatedAt ? row.deployUpdatedAt.toISOString() : null,
    submittedAt: row.submittedAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    updatedAt: row.updatedAt.toISOString(),
    createdAt: row.submittedAt.toISOString(),
    liveUrl: isLive ? `https://${row.slug}.${appsDomain}/` : null,
  };
}

// Safe, self-scoped projection — submitter id is the filter, NOT a returned
// column (so we never echo it back / leak it).
const SELECT = {
  id: true,
  appBlockId: true,
  slug: true,
  version: true,
  status: true,
  rejectionReason: true,
  approvalNotes: true,
  deployState: true,
  deployDetail: true,
  deployUpdatedAt: true,
  submittedAt: true,
  reviewedAt: true,
  updatedAt: true,
} as const;

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  // 1. Auth — Bearer API key → Civitai user via the existing API-key
  // infrastructure (same helper as the public REST API / submit-version).
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ message: 'Missing or malformed Bearer token' });
    return;
  }
  const apiKey = authHeader.slice('bearer '.length).trim();
  if (!apiKey) {
    res.status(401).json({ message: 'Missing or malformed Bearer token' });
    return;
  }
  const session = await getSessionFromBearerToken(apiKey);
  if (!session?.user) {
    res.status(401).json({ message: 'Invalid API key' });
    return;
  }
  const user = session.user as SessionUser;

  // 1b. Token-type gate — IDENTICAL to submit-version: accept a PERSONAL key
  // always; accept an OAUTH-client-issued token ONLY if it carries the dedicated
  // `TokenScope.AppBlocksSubmit` bit (opt-in, off-by-default, EXCLUDED from
  // `TokenScope.Full`). So the SAME token that could submit can read its own
  // submissions; an un-scoped OAuth token → 403 (before the flag/db/work, no
  // leak). An OAuth token authorized for some unrelated scope must not be able
  // to enumerate a mod's submissions.
  if (session.subject?.type === 'oauth') {
    if (!Flags.hasFlag(session.tokenScope, TokenScope.AppBlocksSubmit)) {
      res.status(403).json({
        message:
          'App Blocks status requires a personal API key or an OAuth token with the App Blocks submit scope',
      });
      return;
    }
  }

  // 2. Author gate — App Blocks AUTHORING is mod OR the app-dev-testers cohort
  // (parity with submit-version + withdraw + dev-token). AUTHZ; the
  // isAppBlocksEnabled kill-switch below is separate.
  if (user.bannedAt) {
    res.status(403).json({ message: 'App Blocks is restricted to the civitai team' });
    return;
  }
  if (!(await isAppBlocksAuthorEnabled({ user }))) {
    res.status(403).json({ message: 'App Blocks is restricted to the civitai team' });
    return;
  }

  // 3. Feature flag for THIS user (mirrors submit-version + the prod mint).
  // 503 (dark) when off.
  if (!(await isAppBlocksEnabled({ user }))) {
    res.status(503).json({ message: 'App Blocks is not enabled' });
    return;
  }

  // 4. Validate query (optional single-item narrowing).
  const parsed = querySchema.safeParse({
    id: firstQuery(req.query.id),
    blockId: firstQuery(req.query.blockId),
  });
  if (!parsed.success) {
    res.status(422).json({ message: 'Invalid query', details: parsed.error.flatten() });
    return;
  }
  const { id, blockId } = parsed.data;

  // 5. Rate limit — per-user (the stable authenticated identity), client-IP
  // fallback. Same atomic SET NX EX + INCR MULTI as submit-version/dev-token;
  // fail CLOSED on a malformed limiter result or a Redis incident.
  const rateSubject = user.id ? `u:${user.id}` : `ip:${clientIp(req)}`;
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.SUBMISSIONS_RATE_LIMIT}:${rateSubject}` as const;
  let count: number;
  try {
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: RATE_LIMIT.windowSeconds })
      .incr(rateKey)
      .exec();
    count = Number(multiResult?.[1]);
  } catch (err) {
    req.log?.warn('blocks/submissions: rate limiter threw; failing closed', { rateSubject });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  if (!Number.isFinite(count)) {
    req.log?.warn('blocks/submissions: rate-limit counter malformed; failing closed', {
      rateSubject,
    });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  // Self-heal a TTL-less key (re-arm only when the TTL is actually missing, so
  // an active window is never extended) — same footgun guard as dev-token.
  if (count > 1) {
    const ttl = await sysRedis.ttl(rateKey).catch(() => -1);
    if (ttl < 0) await sysRedis.expire(rateKey, RATE_LIMIT.windowSeconds).catch(() => {});
  }
  if (count > RATE_LIMIT.max) {
    const retryAfter = await sysRedis.ttl(rateKey);
    res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
    res.status(429).json({
      message: 'Rate limit exceeded',
      retryAfterSeconds: retryAfter,
      limit: RATE_LIMIT.max,
      windowSeconds: RATE_LIMIT.windowSeconds,
    });
    return;
  }

  const { env } = await import('~/env/server');
  const appsDomain = env.APPS_DOMAIN || APPS_DOMAIN_FALLBACK;

  // The response carries the caller's own private review/deploy state — never
  // let an intermediary cache it.
  res.setHeader('Cache-Control', 'no-store');

  // 6. SELF-SCOPED read. `submittedByUserId === user.id` is ALWAYS the first
  // (and only ownership-deciding) clause — the request can NEVER widen it. The
  // optional id/blockId only further narrow within the caller's own rows.
  const where: {
    submittedByUserId: number;
    id?: string;
    slug?: string;
  } = { submittedByUserId: user.id };
  if (id) where.id = id;
  if (blockId) where.slug = blockId;

  // Single-item lookup by id: a not-found / not-owned id → 404 (NOT 403), so the
  // existence of another user's submission id isn't an ownership oracle — exactly
  // like dev-token's not-owned → 404.
  if (id) {
    const row = (await dbRead.appBlockPublishRequest.findFirst({
      where,
      select: SELECT,
    })) as SubmissionRow | null;
    if (!row) {
      res.status(404).json({ message: 'Submission not found' });
      return;
    }
    res.status(200).json({ submission: shapeRow(row, appsDomain) });
    return;
  }

  // List the caller's submissions, newest first.
  const rows = (await dbRead.appBlockPublishRequest.findMany({
    where,
    orderBy: { submittedAt: 'desc' },
    take: MAX_ROWS,
    select: SELECT,
  })) as SubmissionRow[];

  res.status(200).json({ submissions: rows.map((r) => shapeRow(r, appsDomain)) });
});
