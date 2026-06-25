import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';
import * as z from 'zod';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { withdrawRequest } from '~/server/services/blocks/publish-request.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * POST /api/v1/blocks/withdraw
 *
 * TOKEN-AUTHENTICATED, SELF-SCOPED withdrawal of the caller's OWN pending
 * App-Block publish (submission) request. This is the server-side surface that
 * unblocks the `civitai app withdraw` CLI command (cli #29): a developer who
 * submitted via `civitai app submit` (`POST /api/v1/blocks/submit-version`) can
 * now pull a still-pending submission back from review with the SAME token,
 * without a moderator browser.
 *
 * It exposes the ALREADY-EXISTING, ownership-safe
 * `withdrawRequest({ publishRequestId, userId })` service (which itself 404s on
 * a missing row, refuses to touch another user's row, is a no-op when already
 * withdrawn, and refuses to withdraw a non-`pending` request). This route does
 * NOT re-implement that logic — it only authenticates the caller and maps the
 * service's outcomes onto HTTP status codes WITHOUT leaking an ownership oracle.
 *
 * ## Auth — mirrors `GET /api/v1/blocks/submissions` /
 *    `POST /api/v1/blocks/submit-version` EXACTLY, so the token that submitted
 *    can withdraw:
 *   - `Authorization: Bearer <civitai API key>` resolved via
 *     `getSessionFromBearerToken` (the same helper backing all `/api/v1/*` REST
 *     auth) — NO new key system.
 *   - A PERSONAL key always passes the token-type gate.
 *   - An OAUTH-client-issued token passes ONLY if it carries the dedicated
 *     `TokenScope.AppBlocksSubmit` bit (the same gate submit-version + the
 *     submissions read use; the first-party `civitai-cli` client is provisioned
 *     with it). An un-scoped OAuth token → 403. This keeps the write in lockstep
 *     with the submit: the same credential that could submit can withdraw its
 *     own submission, and nothing weaker.
 *   - MOD-ONLY pre-GA (`isAppBlocksEnabled({ user })` + `user.isModerator`,
 *     not banned) — identical posture to submit-version + submissions +
 *     dev-token. RELAX in lockstep with the rest of App Blocks at GA, not
 *     unilaterally.
 *
 * ## Self-scoping — the security crux
 * The ONLY mutation input is `publishRequestId`. Ownership is enforced inside
 * `withdrawRequest` (which compares the row's `submittedByUserId` against the
 * authenticated caller's id). There is NO request input that can target another
 * user's row: a `publishRequestId` the caller doesn't own resolves to a 404 —
 * the SAME response as a `publishRequestId` that doesn't exist at all — so the
 * existence of another user's submission is never an ownership oracle. A
 * developer can only ever withdraw their own pending submission.
 *
 * ## Why no CSRF / Origin guard (same reasoning as submit-version / submissions)
 * Bearer-authed: the credential rides an `Authorization` header a cross-site
 * form can't set and the browser never attaches automatically — no ambient
 * authority, so the Origin guard is intentionally omitted (it would also break
 * the headless CLI, which sends no Origin).
 */
export const config = {
  api: {
    // Body is a tiny JSON object ({ publishRequestId }); cap small so a
    // determined caller can't push parse pressure on a stray body.
    bodyParser: { sizeLimit: '8kb' },
  },
};

// A write — keep the window tighter than the submissions read (60/60s) but
// still generous enough for an interactive CLI + a couple of retries. Per-user
// fixed window, fail-closed on a malformed limiter.
const RATE_LIMIT = { max: 30, windowSeconds: 60 } as const;

const bodySchema = z.object({
  // The `pubreq_<ULID>` of the request to withdraw. Self-scoping is enforced in
  // the service by `submittedByUserId` — this id only NAMES a row, it can never
  // widen authority (not-owned / not-found → 404).
  publishRequestId: z.string().min(1).max(128),
});

function clientIp(req: NextApiRequest): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  return (first ?? req.socket?.remoteAddress ?? 'unknown').trim();
}

export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ message: 'Method not allowed' });
    return;
  }

  // 1. Auth — Bearer API key → Civitai user via the existing API-key
  // infrastructure (same helper as the public REST API / submit-version /
  // submissions).
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

  // 1b. Token-type gate — IDENTICAL to submit-version / submissions: accept a
  // PERSONAL key always; accept an OAUTH-client-issued token ONLY if it carries
  // the dedicated `TokenScope.AppBlocksSubmit` bit (opt-in, off-by-default,
  // EXCLUDED from `TokenScope.Full`). So the SAME token that could submit can
  // withdraw its own submission; an un-scoped OAuth token → 403 (before the
  // flag/db/work, no leak).
  if (session.subject?.type === 'oauth') {
    if (!Flags.hasFlag(session.tokenScope, TokenScope.AppBlocksSubmit)) {
      res.status(403).json({
        message:
          'App Blocks withdraw requires a personal API key or an OAuth token with the App Blocks submit scope',
      });
      return;
    }
  }

  // 2. Moderator gate — App Blocks is mod-only pre-GA (parity with
  // submit-version + submissions + dev-token).
  if (!user.isModerator || user.bannedAt) {
    res.status(403).json({ message: 'App Blocks is restricted to the civitai team' });
    return;
  }

  // 3. Feature flag for THIS user (mirrors submit-version + the prod mint).
  // 503 (dark) when off.
  if (!(await isAppBlocksEnabled({ user }))) {
    res.status(503).json({ message: 'App Blocks is not enabled' });
    return;
  }

  // 4. Validate body (the single publishRequestId).
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  const { publishRequestId } = parsed.data;

  // 5. Rate limit — per-user (the stable authenticated identity), client-IP
  // fallback. Same atomic SET NX EX + INCR MULTI as submissions/submit-version/
  // dev-token; fail CLOSED on a malformed limiter result or a Redis incident.
  const rateSubject = user.id ? `u:${user.id}` : `ip:${clientIp(req)}`;
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.WITHDRAW_RATE_LIMIT}:${rateSubject}` as const;
  let count: number;
  try {
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: RATE_LIMIT.windowSeconds })
      .incr(rateKey)
      .exec();
    count = Number(multiResult?.[1]);
  } catch (err) {
    req.log?.warn('blocks/withdraw: rate limiter threw; failing closed', { rateSubject });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  if (!Number.isFinite(count)) {
    req.log?.warn('blocks/withdraw: rate-limit counter malformed; failing closed', {
      rateSubject,
    });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  // Self-heal a TTL-less key (re-arm only when the TTL is actually missing, so
  // an active window is never extended) — same footgun guard as submissions.
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

  // The response is the caller's own private mutation outcome — never cache it.
  res.setHeader('Cache-Control', 'no-store');

  // 6. SELF-SCOPED mutation. `withdrawRequest` enforces ownership internally
  // (compares the row's `submittedByUserId` to `user.id`) and is idempotent on
  // an already-withdrawn row. We map its outcomes onto HTTP WITHOUT an ownership
  // oracle:
  //   - success (incl. idempotent already-withdrawn) → 200 { ok: true }
  //   - not-found OR not-owned → 404 (SAME body for both — never reveal that a
  //     row exists but belongs to another user)
  //   - non-pending (approved/rejected) → 409 (Conflict). This branch is only
  //     reachable AFTER the service's ownership check passes, so the row is
  //     provably the CALLER'S own — disclosing its status to its owner is safe.
  try {
    await withdrawRequest({ publishRequestId, userId: user.id });
    res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Ownership / existence collapse to one indistinguishable 404 (no oracle).
    if (message.includes('not found') || message.includes('you can only withdraw your own')) {
      res.status(404).json({ message: 'Publish request not found' });
      return;
    }
    // The caller owns this row (ownership check already passed inside the
    // service) but it's no longer pending — disclose the conflict to its owner.
    if (message.includes('cannot withdraw a request in status')) {
      res.status(409).json({ error: message });
      return;
    }
    // Unexpected — log + 500, like submissions' catch-all.
    req.log?.error('blocks/withdraw: unexpected error', { message, userId: user.id });
    res.status(500).json({ message: 'Internal server error' });
  }
});
