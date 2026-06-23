import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';
import * as z from 'zod';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { dbWrite } from '~/server/db/client';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { BlockTokenService } from '~/server/services/block-token.service';
import {
  isKnownBlockScope,
  validateBlockScopesAgainstOauthClient,
} from '~/shared/constants/block-scope.constants';
import { domainBrowsingCeiling } from '~/shared/constants/browsingLevel.constants';
import { isPageSlot, PAGE_FORBIDDEN_SCOPES, PAGE_SLOT_ID } from '~/shared/constants/slot-registry';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * POST /api/v1/blocks/dev-token
 *
 * Mints a SHORT-LIVED, SCOPED, SELF-BOUND App-Block PAGE token so a logged-in
 * DEVELOPER can drive their LOCAL harness's "live" mode against the real
 * Civitai backend — testing local code with the dev's OWN real Buzz. This is
 * the deliberately-different DEV path; the production mint at
 * `/api/v1/block-tokens` stays untouched (exact-host same-origin, install-row
 * bound).
 *
 * Designed per claudedocs/app-blocks-dev-token-endpoint-scope.md (§3 Option A,
 * §4 Security Model). SCOPE OF THIS PR = the endpoint + its server-side caps +
 * tests. The SDK-side `createLiveHost` proxy-host (forwarding the postMessage
 * protocol to real endpoints) is the larger half and is EXPLICITLY OUT OF SCOPE
 * — documented follow-up (scope doc §5.2, Phase 2).
 *
 * ## "Existing-app" mode (the ONLY mode shipped here — scope doc §3.3)
 * The dev names an app they OWN (by `appBlockId` or `slug`). Scopes/budget are
 * pinned to that APPROVED `AppBlock` row + its app's OAuth ceiling, so the blast
 * radius ≈ prod and there is no escalation via an un-reviewed local manifest.
 * The "local-manifest" mode (no approved row) is the higher-risk Phase 4 work
 * and is NOT implemented.
 *
 * ## Auth — PERSONAL API key only (Bearer), resolved via the same
 * `getSessionFromBearerToken` path the `/api/v1/*` REST routes use.
 *  - Personal key (not cookie) → there is NO ambient credential to ride, so
 *    CSRF is moot and we accept the dev's localhost origin WITHOUT relaxing the
 *    prod mint's CORS. (scope doc §4.2 — the deliberately-different dev path.)
 *  - OAuth-client-issued tokens are REJECTED here: the dev path is personal-key
 *    only; an OAuth dev-token would need its own scope + sign-off (out of scope).
 *
 * ## Gates / hard caps (every one server-side + fail-closed — scope doc §4.1)
 *  - MOD-ONLY (`isAppBlocksEnabled({ user })` + `user.isModerator`) — match the
 *    pre-GA mod posture. The runtime spend procedures already call
 *    `assertViewerIsModerator`, so a non-mod could mint but not spend; we keep
 *    mint mod-gated anyway. RELAX in lockstep with the runtime belt at GA.
 *  - SCOPE CLAMP: granted ⊆ the app's approved scopes ⊆ DEV_TOKEN_SCOPE_ALLOWLIST
 *    (EXCLUDES `social:tip:self` + `block:settings:*`) ⊆ the app's OAuth ceiling
 *    ⊆ requested (if the body narrows). Unknown / out-of-allowlist scopes are
 *    STRIPPED, never error.
 *  - BUDGET CAP: a LOWER dev cap (DEV_BUZZ_BUDGET_CAP) than the prod 1000. The
 *    existing per-user daily cumulative cap (reserveBlockBuzzSpend) is untouched.
 *  - FORCED SFW: maxBrowsingLevel = domainBrowsingCeiling(null) UNCONDITIONALLY
 *    (localhost has no color domain; we never read the request host, so a
 *    color-localhost dev config can't widen maturity). No mature path here.
 *  - SELF-BOUND `sub`: the token's subject is the calling dev's userId; there is
 *    no way to set it from the body.
 *  - SHORT TTL: a PAGE token is signed by BlockTokenService.sign — 15min (the
 *    service default; settings-scope tokens drop to 5min, but those scopes are
 *    excluded here). That's the short, refresh-friendly window the harness wants.
 *  - REVOCABLE: the synthetic `page_<appBlockId>` instance id is BlockRevocation-
 *    checkable, identical to the prod page mint.
 *  - RATE-LIMITED: per-user fixed window (same atomic SET NX EX + INCR shape as
 *    the submit-version limiter), fail-closed on a malformed limiter result.
 */
export const config = {
  api: {
    // Tiny JSON body ({ appBlockId|slug, scopes?, buzzBudget? }). Cap well below
    // Next's 1MB default so a determined caller can't push parse pressure.
    bodyParser: { sizeLimit: '8kb' },
  },
};

// A LOWER dev budget cap than the prod 1000 (scope doc §4.1). The dev spends
// their OWN Buzz and the per-user daily cumulative cap is untouched; this just
// bounds a single submit's reservation.
const DEV_BUZZ_BUDGET_CAP = 250;
const DEV_BUZZ_BUDGET_DEFAULT = 50;

// Forced SFW — the dev endpoint NEVER reads the request host. localhost has no
// color domain, and even a color-localhost dev config must not widen maturity.
const FORCED_SFW_CEILING = domainBrowsingCeiling(null);

const RATE_LIMIT = { max: 30, windowSeconds: 60 } as const;

const PAGE_INSTANCE_PREFIX = 'page_';

/**
 * The DEV scope allowlist (scope doc §4.1): read/catalog scopes + the page
 * spend scope + per-app storage. DELIBERATELY EXCLUDES:
 *   - `social:tip:self` — real money OUT to third parties; no test value, real
 *     abuse value.
 *   - `block:settings:read` / `block:settings:write` — installer-only, and
 *     meaningless against a local instance with no real install row.
 *
 * A requested/approved scope outside this set is STRIPPED from the minted token
 * (defense-in-depth on top of the approved-snapshot pin). `social:tip:self` and
 * `buzz:read:self` are ALSO in PAGE_FORBIDDEN_SCOPES, so the page hard rule
 * below rejects them too — this allowlist is the explicit dev-side belt.
 */
const DEV_TOKEN_SCOPE_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  'models:read:self',
  'media:read:owned',
  'user:read:self',
  'ai:write:budgeted',
  'apps:storage:read',
  'apps:storage:write',
]);

const requestSchema = z
  .object({
    appBlockId: z.string().min(1).max(128).optional(),
    slug: z.string().min(1).max(128).optional(),
    // OPTIONAL narrowing: a subset of the app's approved scopes the dev wants
    // for this token. Omitted → all of the app's approved scopes (minus the
    // dev-excluded ones).
    scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
    // OPTIONAL dev-requested per-call Buzz budget; clamped to DEV_BUZZ_BUDGET_CAP.
    buzzBudget: z.number().int().positive().optional(),
  })
  .refine((b) => !!b.appBlockId || !!b.slug, {
    message: 'one of appBlockId or slug is required',
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

  // Block-token signing must be configured (parity with the prod mint's 503).
  const { env } = await import('~/env/server');
  if (!env.BLOCK_TOKEN_PRIVATE_KEY || !env.BLOCK_TOKEN_PUBLIC_KEY) {
    res.status(503).json({ message: 'Block tokens not configured' });
    return;
  }

  // 1. Auth — Bearer PERSONAL API key resolves to a Civitai user via the same
  // helper that backs the `/api/v1/*` REST auth. (scope doc §3.2 / §4.2)
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

  // 1b. PERSONAL key only. `getSessionFromBearerToken` sets subject.type ===
  // 'oauth' for OAuth-client-issued tokens; the dev path accepts only a
  // user-type personal key (an OAuth dev-token would need its own scope +
  // sign-off — out of scope for this PR).
  if (session.subject?.type === 'oauth') {
    res.status(403).json({ message: 'dev-token requires a personal API key' });
    return;
  }

  // 2. MOD gate — App Blocks is mod-only pre-GA. The runtime spend belt already
  // asserts moderator, but we keep the MINT mod-gated too (scope doc §4 / §6 R2).
  if (!user.isModerator || user.bannedAt) {
    res.status(403).json({ message: 'App Blocks is restricted to the civitai team' });
    return;
  }

  // 3. Feature flag for THIS user (mirrors submit-version + the prod mint's
  // per-user `appBlocks` gate). 503 (dark) when off.
  if (!(await isAppBlocksEnabled({ user }))) {
    res.status(503).json({ message: 'App Blocks is not enabled' });
    return;
  }

  // 4. Validate body.
  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }
  const { appBlockId, slug, scopes: requestedScopes, buzzBudget: requestedBudget } = parsed.data;

  // 5. Rate limit — per-user (the stable authenticated identity), client-IP
  // fallback. Same atomic SET NX EX + INCR pattern as submit-version; fail
  // CLOSED on a malformed limiter result (never silently bypass a mint).
  const rateSubject = user.id ? `u:${user.id}` : `ip:${clientIp(req)}`;
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.DEV_TOKEN_RATE_LIMIT}:${rateSubject}` as const;
  let count: number;
  try {
    const multiResult = await sysRedis
      .multi()
      .set(rateKey, '0', { NX: true, EX: RATE_LIMIT.windowSeconds })
      .incr(rateKey)
      .exec();
    count = Number(multiResult?.[1]);
  } catch (err) {
    // A Redis incident must NEVER silently bypass the mint — fail closed.
    req.log?.warn('blocks/dev-token: rate limiter threw; failing closed', { rateSubject });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  if (!Number.isFinite(count)) {
    req.log?.warn('blocks/dev-token: rate-limit counter malformed; failing closed', {
      rateSubject,
    });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  // Self-heal a TTL-less key: `SET NX EX` only arms the TTL on first creation, so
  // a key left around without an expiry (a prior crash / manual SET) would make
  // the window permanent and lock this user out forever (fail-closed, but a real
  // footgun). Re-arm only when the TTL is actually missing, so we never extend an
  // active window. Best-effort — mirrors block-token.service.ts:274-275.
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

  // 6. Resolve the APPROVED AppBlock the dev OWNS. Ownership = the app's
  // OauthClient.userId (the AppBlock → app → user relation). We use dbWrite so a
  // freshly-approved/suspended app can't slip through a replication-lag window.
  // The lookup also fetches `app.userId` (owner) which resolvePageBlock doesn't
  // expose, so we read the row directly here (we do NOT modify the prod path).
  const where = appBlockId ? { id: appBlockId } : { blockId: slug! };
  const block = await dbWrite.appBlock.findUnique({
    where: where as { id: string } | { blockId: string },
    select: {
      id: true,
      blockId: true,
      appId: true,
      status: true,
      manifest: true,
      approvedScopes: true,
      app: { select: { allowedScopes: true, userId: true } },
    },
  });
  // 404 (never leak which) for missing / not-approved / not-owned. Ownership is
  // checked AFTER existence but we collapse them into one 404 so a non-owner
  // can't probe which appBlockIds exist.
  if (!block || block.status !== 'approved' || !block.app) {
    res.status(404).json({ message: 'App not found' });
    return;
  }
  if (block.app.userId !== user.id) {
    // Not the owner → 404, not 403, so ownership isn't a probe oracle.
    res.status(404).json({ message: 'App not found' });
    return;
  }

  // The app MUST declare a page block — dev-token mints PAGE tokens only (the
  // live-local target is a page app; no model binding). A region/model-only app
  // has no page surface to mint for.
  const manifest = (block.manifest ?? {}) as { page?: unknown; scopes?: unknown };
  if (typeof manifest.page !== 'object' || manifest.page === null) {
    res.status(422).json({ message: 'dev-token mints page tokens; this app declares no page block' });
    return;
  }

  // 7. SCOPE CLAMP. Start from the app's APPROVED snapshot (authoritative — the
  // same pin the prod mint uses), then:
  //   a) keep only KNOWN block scopes,
  //   b) keep only scopes within the DEV_TOKEN_SCOPE_ALLOWLIST (excludes
  //      social:tip:self + block:settings:*),
  //   c) keep only scopes within the app's OAuth ceiling (allowedScopes),
  //   d) drop the PAGE_FORBIDDEN money/spend scopes (the page hard rule),
  //   e) if the body requested a subset, intersect with it.
  // Every step is a STRIP (no error) so a partially-disallowed request still
  // mints a usable, safely-clamped token.
  const approvedRaw: unknown[] = Array.isArray(block.approvedScopes) ? block.approvedScopes : [];
  const approved: string[] = approvedRaw.filter((s): s is string => typeof s === 'string');
  const oauthAllowed: number = block.app.allowedScopes ?? 0;
  const forbidden = new Set<string>(PAGE_FORBIDDEN_SCOPES);

  let granted: string[] = approved
    .filter((s) => isKnownBlockScope(s))
    .filter((s) => DEV_TOKEN_SCOPE_ALLOWLIST.has(s))
    .filter((s) => !forbidden.has(s));

  // OAuth-ceiling clamp — drop any scope the app's OauthClient bitmask doesn't
  // allow. validateBlockScopesAgainstOauthClient treats SKIP_OAUTH_CHECK scopes
  // (apps:storage:*) as always-allowed, so per-scope re-validation keeps those.
  granted = granted.filter(
    (s: string) => validateBlockScopesAgainstOauthClient([s], oauthAllowed).valid
  );

  // Body narrowing — the dev may request a subset of the above.
  if (requestedScopes && requestedScopes.length > 0) {
    const want = new Set(requestedScopes);
    granted = granted.filter((s: string) => want.has(s));
  }

  //   f) PERSONAL-KEY CEILING. The minted block token's spend capability must be
  //      a SUBSET of what the dev's own personal API key authorizes — a key
  //      lacking AIServicesWrite (e.g. a read-only key) cannot mint a
  //      Buzz-spending dev token. Mirrors the /api/v1/me tokenScope posture
  //      (me.ts:24). Read/catalog/storage scopes are unaffected; only the
  //      budgeted-spend scope is gated. Keys default to Full, so this is a
  //      no-op for a normal key and a tightening only for a deliberately-narrow
  //      one. Strip (no error), consistent with every other clamp step.
  const keyCanSpend = Flags.hasFlag(session.tokenScope ?? 0, TokenScope.AIServicesWrite);
  if (!keyCanSpend) {
    granted = granted.filter((s: string) => s !== 'ai:write:budgeted');
  }

  // Dedup, deterministic order.
  granted = Array.from(new Set(granted)).sort();

  // 8. BUDGET CAP — only meaningful when ai:write:budgeted is granted. Clamp the
  // dev-requested budget (or the default) to the LOWER dev cap.
  const buzzBudget = granted.includes('ai:write:budgeted')
    ? Math.min(requestedBudget ?? DEV_BUZZ_BUDGET_DEFAULT, DEV_BUZZ_BUDGET_CAP)
    : undefined;

  // 9. Synthetic, revocable PAGE instance id — same shape as the prod page mint
  // (`page_<appBlockId>`), so BlockRevocation per blockInstanceId works
  // unchanged and the harness uses the identical token-handling.
  const blockInstanceId = `${PAGE_INSTANCE_PREFIX}${block.id}`;

  // 10. PAGE ctx (entity=none, no model binding) — byte-identical shape to the
  // prod page mint, so a dev page token can NEVER satisfy a model-bound check.
  const ctx: Record<string, unknown> = {
    slotId: PAGE_SLOT_ID,
    entityType: 'none',
  };
  // Defense-in-depth: PAGE_SLOT_ID is a page slot by construction; assert it.
  if (!isPageSlot(PAGE_SLOT_ID)) {
    res.status(500).json({ message: 'page slot misconfigured' });
    return;
  }

  // 11. SIGN — reuse BlockTokenService.sign VERBATIM. Self-bound sub (userId),
  // forced-SFW ceiling, dev-capped budget, page ctx. domain is null (no host
  // read) — advisory only; the AUTHORITATIVE ceiling is maxBrowsingLevel.
  const result = await BlockTokenService.sign({
    userId: user.id,
    blockId: block.blockId,
    appId: block.appId,
    appBlockId: block.id,
    blockInstanceId,
    scopes: granted,
    ctx,
    buzzBudget,
    domain: null,
    maxBrowsingLevel: FORCED_SFW_CEILING,
  });

  // The body carries a bearer JWT — never let an intermediary cache it.
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    token: result.token,
    expiresAt: result.expiresAt,
    scopes: granted,
    buzzBudget,
    maxBrowsingLevel: FORCED_SFW_CEILING,
    blockInstanceId,
  });
});
