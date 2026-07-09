import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import * as z from 'zod';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { dbWrite } from '~/server/db/client';
import { sysRedis, REDIS_SYS_KEYS, withSysReadDeadline } from '~/server/redis/client';
import { SLUG_REGEX } from '~/server/schema/blocks/publish-request.schema';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import {
  clampDevScopes,
  DEV_TOKEN_SCOPE_ALLOWLIST,
  FORCED_SFW_CEILING,
  resolveDevBuzzBudget,
  signDevScopedPageToken,
} from '~/server/services/blocks/dev-scoped-mint.service';
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
 * ## Three resolution modes (scope doc §3.3, §4, Phase 4)
 *
 * 1. "Existing-app" mode — the dev names an app they OWN (by `appBlockId` or
 *    `slug`) that has an APPROVED `AppBlock` row. Scopes/budget are pinned to
 *    that approved snapshot + its app's OAuth ceiling, so the blast radius ≈
 *    prod and there is no escalation via an un-reviewed local manifest.
 *
 * 2. "Pending-app local-manifest" mode (Phase 4) — reached ONLY when no owned
 *    APPROVED row exists AND the caller passed a `slug` that matches a
 *    `AppBlockPublishRequest` with `status='pending'` that THEY submitted
 *    (`submittedByUserId === user.id`). This unblocks the `dev:live` real-Buzz
 *    path for a SUBMITTED-but-not-yet-approved app — before today that 404'd
 *    because the mint required an approved row. The scope SOURCE is the pending
 *    request's UN-REVIEWED `manifest.scopes` (developer-controlled, NOT
 *    moderator-approved) — the §4 R1 escalation surface — so it is clamped by
 *    the IDENTICAL belt as the approved path WITH ONE SUBSTITUTION:
 *      - a pending app has NO OauthClient → there is no OAuth-bitmask ceiling
 *        (step 7c). Passing `oauthAllowed: 0` into
 *        validateBlockScopesAgainstOauthClient would WRONGLY STRIP every
 *        non-SKIP_OAUTH_CHECK scope (`(0 & bit) !== bit`), so the step is simply
 *        OMITTED for the pending path. The CORRECT substitute ceiling is the
 *        dev's OWN credential, ALREADY enforced at step 7f (the
 *        bearer-credential spend ceiling: `ai:write:budgeted` survives only if
 *        the bearer carries `AIServicesWrite`). 7f is the authoritative spend
 *        gate here. Every OTHER clamp (isKnownBlockScope, DEV_TOKEN_SCOPE_-
 *        ALLOWLIST, PAGE_FORBIDDEN_SCOPES, body-narrowing, force-grant
 *        `user:read:self`) and EVERY hard cap (DEV_BUZZ_BUDGET_CAP, forced SFW,
 *        self-bound `sub`, short TTL, rate limit, mod-only pre-GA) is applied
 *        IDENTICALLY — the pending path relaxes NOTHING.
 *
 *    Residual risk (honest): the manifest is un-reviewed, so a developer could
 *    declare any scope. But each declared scope is bounded by ≤ the dev's own
 *    credential authority (7f for spend), ⊆ DEV_TOKEN_SCOPE_ALLOWLIST, and minus
 *    PAGE_FORBIDDEN_SCOPES; spend is the dev's OWN budget-capped Buzz against the
 *    untouched per-user daily cap; the runtime spend belt still asserts
 *    moderator pre-GA. The R1-escalation test proves an escalated manifest scope
 *    (`social:tip:self`, `block:settings:write`, an unknown/mature scope) is
 *    STRIPPED, never minted.
 *
 *    APPID MISATTRIBUTION (audit S1 — FIXED): the pending path mints a SYNTHETIC
 *    `appId = pending-<publishRequestId>`, NOT the deterministic `appblk-<slug>`
 *    an approved app would get. Were it `appblk-<slug>`, an adversarial mod-tier
 *    dev could file a *pending* request for a slug an APPROVED app owned by a
 *    DIFFERENT user already holds (the submit guard blocks only same-slug pending
 *    collisions, not pending-vs-approved), skip the approved branch (not their
 *    app), reach this pending branch, and mint a token whose `appId` resolves —
 *    in `recordSpendAttribution` — to the VICTIM's real OauthClient, writing a
 *    forged `blockSpendAttribution` row (status='tracked', appOwnerUserId=victim,
 *    real grossValueCents). That row is exactly what the deferred payout rail
 *    (#2605 Slice-4 backpay) reads to pay `gross × spendSharePct`. Dormant today
 *    (spendSharePct=0, no money moves) but a forged accrual ledger would persist
 *    into the payout window. The synthetic `pending-pubreq_<ULID>` can never match
 *    an `appblk-*` id nor a real `OauthClient.id`, so the attribution lookup MISSES
 *    → the inert `if (!app)` skip-write path → no row written (correct: a pending
 *    dev-test spend has no approved app to attribute to). GATE: before #2605 turns
 *    on a non-zero `spendSharePct`, re-confirm no pending-path mint can ever land a
 *    real `OauthClient.id` in `appId`.
 *
 *    PENDING-PATH AUDIT GATE (FIX 🟡-1): a pending-app dev mint has NO
 *    AppBlock-backed audit rows — recordSpendAttribution throws+swallows on the
 *    synthetic appId and recordScopeInvocation FK-fails on the synthetic
 *    appBlockId, so the ONLY durable trail is the structured
 *    `blocks.dev-token.pending-mint` log event (userId/slug/publishRequestId/
 *    scopes/spendGranted) emitted at mint time (queryable in Axiom/Loki). GATE:
 *    durable, per-spend audit rows for pending apps (e.g. a nullable-appBlockId
 *    schema change so recordScopeInvocation can persist) is a GA-gate item before
 *    pending-app dev spend is widened past the mod-only pre-GA posture.
 *
 *    OWNERSHIP / NO-ORACLE: only the `slug` input can reach the pending path
 *    (pending apps have no `appBlockId`); a row the caller doesn't own — or no
 *    row at all — returns the SAME bare `404 { message: 'App not found' }` as
 *    the approved path (never an existence/ownership/state oracle). Only a row
 *    the caller demonstrably owns surfaces an actionable message.
 *
 * 3. "No-row local-manifest" mode (Phase 4 — the deliberately-deferred mode,
 *    NOW IMPLEMENTED) — reached ONLY when the caller passed a `slug`, NO
 *    APPROVED `AppBlock` exists for that slug AT ALL (`block == null`), AND no
 *    caller-owned pending request exists. This unblocks `dev:live` for a
 *    BRAND-NEW app the dev has NOT yet submitted/registered — there is no server
 *    row of any kind, so the scope SOURCE is the CLIENT-SUPPLIED request body
 *    `scopes` (the dev's LOCAL `block.manifest.json`, sent by the CLI; entirely
 *    un-reviewed, developer-controlled — the strongest §4 R1 escalation
 *    surface). It is clamped by the IDENTICAL belt as the pending path: there is
 *    NO OauthClient (OAuth-ceiling clamp OMITTED), so the §4 R1 / step-7f
 *    bearer-credential `AIServicesWrite` SPEND CEILING is the AUTHORITATIVE
 *    spend gate (`ai:write:budgeted` survives only if the dev's OWN key carries
 *    AIServicesWrite). Every OTHER clamp (isKnownBlockScope, DEV_TOKEN_SCOPE_-
 *    ALLOWLIST, PAGE_FORBIDDEN_SCOPES, force-grant `user:read:self`) and EVERY
 *    hard cap (DEV_BUZZ_BUDGET_CAP + default, forced SFW, self-bound `sub`,
 *    short TTL, rate limit, mod-only pre-GA) applies IDENTICALLY — it relaxes
 *    NOTHING. Page-only by construction (dev-token mints page tokens only; no
 *    server manifest to inspect). An empty/absent body `scopes` mints a
 *    read-only token (no spend) — not a 404.
 *
 *    GUARD (NO-SHADOW — the critical new check): this mode fires ONLY when
 *    `block == null` (no approved AppBlock for the slug exists at all). If an
 *    APPROVED `AppBlock` for the slug EXISTS but is owned by someone else
 *    (`block` non-null, `block.app.userId !== user.id`), the no-row path does
 *    NOT fire — control returns the bare `404 { message: 'App not found' }`
 *    (no ownership oracle, same as the approved/pending miss). Rationale: a dev
 *    must NEVER mint a "local" token for a slug a real published app owns
 *    (no shadowing / attribution confusion). A foreign-owned approved row falls
 *    through to the pending(caller) miss → 404, and is gated OUT of the no-row
 *    path by the `block == null` condition.
 *
 *    SYNTHETIC, NON-RESOLVING appId (audit S1 parity): the no-row path mints
 *    `appId = local-<slug>`, NOT the deterministic `appblk-<slug>` an approved
 *    app would hold. Real `OauthClient.id`s are either UUIDv4 (user-created,
 *    oauth-client.router.ts) or `appblk-<slug>` (App-Blocks provisioned) — a
 *    `local-` prefix can NEVER match either, so recordSpendAttribution's
 *    `oauthClient.findUnique({ id })` MISSES → the inert skip-write path → no
 *    forged `blockSpendAttribution` row (identical S1 protection to the
 *    pending path's `pending-<pubreqId>`). `appBlockId` claim / `blockInstanceId`
 *    use a synthetic `page_local_<slug>` (string-validated only; no FK resolves).
 *
 *    AUDIT TRAIL: as with the pending path, the no-row path has NO durable
 *    AppBlock-backed audit rows (the synthetic appId/appBlockId don't resolve),
 *    so the ONLY forensic trail is the structured `blocks.dev-token.local-mint`
 *    log event (userId/slug/scopes/spendGranted), queryable in Axiom/Loki.
 *    Same GA-gate as the pending path: durable per-spend audit rows are required
 *    before no-row dev spend is widened past the mod-only pre-GA posture.
 *
 *    ENUMERATION ORACLE (audit 🟡-2 — GA-gate, no code change pre-GA): the no-row
 *    path returns a 200 read-only mint for an UNREGISTERED slug but a bare 404 for
 *    a slug owned by a *different* account's APPROVED app (the `block == null`
 *    guard sends a foreign-owned approved row to the bare 404, not the no-row
 *    branch). That 200-vs-404 difference is a mod-only existence oracle for
 *    approved-slug occupancy. Acceptable pre-GA (this endpoint is mod-gated and
 *    approved-app slugs are already semi-public at `<slug>.civit.ai`), but
 *    re-confirm this is tolerable before widening dev-token past moderators.
 *
 * ## Auth — Bearer, resolved via the same `getSessionFromBearerToken` path the
 * `/api/v1/*` REST routes use. TWO credential shapes accepted:
 *  - PERSONAL API key (not cookie) → there is NO ambient credential to ride, so
 *    CSRF is moot and we accept the dev's localhost origin WITHOUT relaxing the
 *    prod mint's CORS. (scope doc §4.2 — the deliberately-different dev path.)
 *  - OAuth-client-issued token → accepted ONLY if it carries the dedicated
 *    `TokenScope.AppBlocksSubmit` bit. This MIRRORS EXACTLY the OAuth gate the
 *    token-authenticated submit route (`api/v1/blocks/submit-version`) applies
 *    (`session.subject?.type === 'oauth'` ⇒ require `AppBlocksSubmit`). It
 *    unblocks `civitai login` (device-flow OAuth) for the dev:live harness:
 *    `oauthClient.create` is open to any logged-in user, so an arbitrary OAuth
 *    token a mod authorized for some unrelated scope must NOT mint a dev token
 *    (consent escalation). `AppBlocksSubmit` is opt-in, off-by-default, and
 *    EXCLUDED from `TokenScope.Full`, so only a client that explicitly lists it
 *    in `allowedScopes` AND a user who consented can reach here (the first-party
 *    `civitai-cli` client is provisioned with it). An OAuth token WITHOUT the
 *    bit → 403 with an actionable message.
 *  - The SPEND scope is UNIFORM across both shapes: `ai:write:budgeted` survives
 *    the clamp ONLY if the bearer credential carries `AIServicesWrite` (the
 *    personal-key ceiling at step 7f). An OAuth token whose `civitai-cli` consent
 *    lacks `AIServicesWrite` therefore mints a read/estimate dev token with NO
 *    spend scope — `AppBlocksSubmit` is NOT special-cased to grant spend.
 *
 * ## Gates / hard caps (every one server-side + fail-closed — scope doc §4.1)
 *  - MOD-ONLY (`isAppBlocksEnabled({ user })` + `user.isModerator`) — match the
 *    pre-GA mod posture. The runtime spend procedures already call
 *    `assertViewerIsModerator`, so a non-mod could mint but not spend; we keep
 *    mint mod-gated anyway. RELAX in lockstep with the runtime belt at GA.
 *  - SCOPE CLAMP: granted ⊆ the scope source ⊆ DEV_TOKEN_SCOPE_ALLOWLIST
 *    (EXCLUDES `social:tip:self` + `block:settings:*`) ⊆ [the app's OAuth
 *    ceiling — approved path ONLY] ⊆ requested (if the body narrows), then the
 *    bearer-credential spend ceiling (7f) gates `ai:write:budgeted`. The scope
 *    SOURCE is the app's APPROVED snapshot (existing-app mode) OR the OWNED
 *    pending request's un-reviewed `manifest.scopes` (local-manifest mode, where
 *    the absent OAuth ceiling is replaced by 7f). Unknown / out-of-allowlist
 *    scopes are STRIPPED, never error.
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

// The DEV budget caps, forced-SFW ceiling, and the DEV_TOKEN_SCOPE_ALLOWLIST
// (read/catalog + page spend + per-app storage; EXCLUDES social:tip:self +
// block:settings:*) now live in dev-scoped-mint.service so the Phase-2 cookie
// host-mint reuses the identical belt. Imported above.
const RATE_LIMIT = { max: 30, windowSeconds: 60 } as const;

const PAGE_INSTANCE_PREFIX = 'page_';

// No-row (local-manifest) appId prefix. Real OauthClient.ids are either UUIDv4
// (user-created, oauth-client.router.ts) or `appblk-<slug>` (App-Blocks
// provisioned), so a `local-<slug>` appId can NEVER resolve in
// recordSpendAttribution's `oauthClient.findUnique({ id })` — guaranteeing the
// attribution write is skipped (audit S1 parity with the pending path).
const LOCAL_APP_ID_PREFIX = 'local-';

const requestSchema = z
  .object({
    appBlockId: z.string().min(1).max(128).optional(),
    // SLUG_REGEX + canonical app-slug BOUNDS (audit N1 + 🟡-1): the no-row path
    // builds synthetic `local-<slug>` / `page_local_<slug>` ids from this value,
    // so a malformed slug must 400 BEFORE any lookup or synthetic-id construction.
    // This makes the "`local-<slug>` can never collide with a real OauthClient.id"
    // guarantee airtight BY CONSTRUCTION (only lowercase alnum+hyphen slugs
    // reach the constructor) rather than resting on prefix-collision reasoning.
    //
    // The bounds MATCH the canonical platform app-slug schema (publish-request
    // .schema.ts submitVersionSchema/getMyPendingForSlugSchema/backfill —
    // `min(3).max(40).regex(SLUG_REGEX)`), NOT a looser `min(1).max(128)`. A real
    // approved/pending app slug is min(3).max(40) BY CONSTRUCTION (validated at
    // submit/create time), so every legitimate slug already conforms and no
    // approved/pending path regresses — but the lax bound would have let dev-token
    // mint a synthetic id for a 2-char / >40-char slug NO real app could ever
    // hold. Aligning the bounds removes that two-definitions-of-valid-slug split
    // on this money-path endpoint. (There is no exported shared slugSchema /
    // SLUG_MIN_LENGTH constant to reuse — publish-request.schema.ts inlines these
    // same bounds at lines 70/116; matched inline here to mirror it.)
    slug: z.string().min(3).max(40).regex(SLUG_REGEX).optional(),
    // DUAL ROLE:
    //  - approved / pending paths: OPTIONAL narrowing — a subset of the app's
    //    approved (or pending-manifest) scopes the dev wants for this token.
    //    Omitted → all of the app's scopes (minus the dev-excluded ones).
    //  - NO-ROW (local-manifest) path: the SCOPE SOURCE itself (the dev's local
    //    `block.manifest.json` scopes, sent by the CLI). Clamped by the same
    //    belt; absent/empty → a read-only token (no spend).
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

  // 1b. Token-type gate — accept EITHER a personal API key OR a scoped OAuth
  // token, MIRRORING EXACTLY the submit-version route's OAuth gate
  // (src/pages/api/v1/blocks/submit-version.ts:134-142). `getSessionFromBearerToken`
  // sets `subject = { type: 'oauth', id: clientId }` IFF the resolved `ApiKey`
  // row has a non-null `clientId` (minted for an OAuth client a user authorized),
  // and `{ type: 'apiKey', id }` for a user-type personal-access key.
  //
  //  - PERSONAL key (`subject.type !== 'oauth'`): pass unchanged — the dev's own
  //    key mints as before. The mod + flag + ownership gates still apply.
  //
  //  - OAUTH token (`subject.type === 'oauth'`): pass ONLY if the token carries
  //    the dedicated `TokenScope.AppBlocksSubmit` bit. `oauthClient.create` is an
  //    open `protectedProcedure`, so an arbitrary OAuth token a mod authorized
  //    for an unrelated scope must NOT mint a dev token (consent escalation).
  //    `AppBlocksSubmit` is opt-in, off-by-default, and EXCLUDED from
  //    `TokenScope.Full`, so only a client that lists it in `allowedScopes` and a
  //    user who consented can reach here (the first-party `civitai-cli` client is
  //    provisioned with it). This unblocks `civitai login` for the dev:live
  //    harness. Spend is gated SEPARATELY by the AIServicesWrite ceiling (step
  //    7f) — `AppBlocksSubmit` grants the right to MINT, never the right to SPEND.
  //
  // The mod + not-banned gate (step 2) applies to BOTH paths. Ordered after auth
  // (401) and before the mod gate so an un-scoped OAuth token gets 403, not a leak.
  if (session.subject?.type === 'oauth') {
    if (!Flags.hasFlag(session.tokenScope ?? 0, TokenScope.AppBlocksSubmit)) {
      res.status(403).json({
        message:
          'dev-token needs a personal API key (full scope, create at ' +
          'civitai.com/user/account) OR an OAuth login whose token carries the ' +
          'Apps submit scope; real Buzz spend additionally needs AI Services scope',
      });
      return;
    }
  }

  // 2. Author gate — App Blocks authoring is capability-gated on the dedicated
  // `app-blocks-author` flag (static fallback mod-only), so a curated non-mod
  // cohort can mint a dev token for `dev:live`. A BANNED account is always
  // rejected. The runtime spend belt re-checks the author capability against the
  // token SUBJECT; we keep the MINT author-gated too (scope doc §4 / §6 R2).
  if (user.bannedAt) {
    res.status(403).json({ message: 'Apps are restricted to the Civitai team' });
    return;
  }
  if (!(await isAppBlocksAuthorEnabled({ user }))) {
    res.status(403).json({ message: 'Apps are restricted to the Civitai team' });
    return;
  }

  // 3. Feature flag for THIS user (mirrors submit-version + the prod mint's
  // per-user `appBlocks` gate). 503 (dark) when off.
  if (!(await isAppBlocksEnabled({ user }))) {
    res.status(503).json({ message: 'Apps are not enabled' });
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
    // withSysReadDeadline (#28): the raw sysRedis MULTI runs on the request's
    // critical path. On a SILENT half-open the written command parks in node-redis's
    // reply queue until OS TCP keepalive (~11min) — a HANG, not a throw, so the
    // try/catch alone can't unpark it. Racing the `.exec()` against the sys read
    // deadline (default REDIS_SYS_READ_TIMEOUT_MS=2000) turns that open-ended hang
    // into a clean rejection caught here → fail closed (503) instead of parking.
    const multiResult = await withSysReadDeadline(
      sysRedis
        .multi()
        .set(rateKey, '0', { NX: true, EX: RATE_LIMIT.windowSeconds })
        .incr(rateKey)
        .exec()
    );
    count = Number(multiResult?.[1]);
  } catch (err) {
    // A Redis incident (a throw OR a deadline-bounded hang) must NEVER silently
    // bypass the mint — fail closed.
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
    // Bound the self-heal TTL read too (#28): a hung sysRedis.ttl would park the
    // mint just past the limiter. The deadline reject folds into the existing -1
    // fallback (treat as "no TTL" → best-effort re-arm), never a hang.
    const ttl = await withSysReadDeadline(sysRedis.ttl(rateKey)).catch(() => -1);
    // Fire-and-forget the self-heal re-arm (#28 audit 🟡): this is a best-effort
    // sysRedis WRITE and withSysReadDeadline deliberately does NOT race sys writes
    // (the #2556/#2586 wedge). Awaiting it would re-open the exact park this PR
    // closes — on a client that half-opens AFTER exec() resolved, the awaited
    // expire on the dead socket parks the mint ~11min. `void` lets the response
    // proceed; the .catch keeps the orphaned promise from surfacing as unhandled.
    if (ttl < 0) void sysRedis.expire(rateKey, RATE_LIMIT.windowSeconds).catch(() => {});
  }
  if (count > RATE_LIMIT.max) {
    // Bound the 429-path TTL read (#28) so a hung sysRedis.ttl can't park the
    // over-limit response. On a deadline/throw fall back to the full window.
    const retryAfter = await withSysReadDeadline(sysRedis.ttl(rateKey)).catch(
      () => RATE_LIMIT.windowSeconds
    );
    res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
    res.status(429).json({
      message: 'Rate limit exceeded',
      retryAfterSeconds: retryAfter,
      limit: RATE_LIMIT.max,
      windowSeconds: RATE_LIMIT.windowSeconds,
    });
    return;
  }

  // 6. Resolve the block to mint for. TWO resolution paths (scope doc §3.3, §4,
  // Phase 4). The result is a uniform `resolved` shape consumed by the shared
  // clamp belt (step 7) so neither path can relax a cap:
  //
  //   - scopeSource:      the scopes to clamp DOWN from. Approved snapshot
  //                       (existing-app) OR the OWNED pending request's
  //                       un-reviewed manifest.scopes (local-manifest).
  //   - oauthAllowed:     the OAuth-bitmask ceiling, or null to SKIP that clamp
  //                       step (pending apps have no OauthClient — see 7c below).
  //   - signBlockId/appId/appBlockId/blockInstanceId: the sign + revocation ids.
  //
  // Resolution order is APPROVED-FIRST so the safer (server-pinned) path always
  // wins; the pending path is reached ONLY when no owned approved row exists.

  // 6a. APPROVED path. Ownership = the app's OauthClient.userId (AppBlock → app →
  // user). dbWrite so a freshly-approved/suspended app can't slip a replica-lag
  // window. Lookup also reads `app.userId` (owner) which resolvePageBlock doesn't
  // expose; we read the row directly here (we do NOT modify the prod path).
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

  // A `resolved` block (either path) carries everything the clamp + sign below
  // need. `oauthAllowed: null` ⇒ skip the OAuth-ceiling clamp (no client exists).
  type Resolved = {
    scopeSource: string[];
    oauthAllowed: number | null;
    signBlockId: string;
    signAppId: string;
    signAppBlockId: string;
    blockInstanceId: string;
  };
  let resolved: Resolved | null = null;
  // Set ONLY on the local-manifest (pending) path so the structured mint-audit
  // log (FIX 🟡-1) can fire for pending mints — the only path WITHOUT durable
  // AppBlock-backed audit rows (recordSpendAttribution throws+swallows on the
  // synthetic appId; recordScopeInvocation FK-fails on the synthetic appBlockId).
  let pendingPublishRequestId: string | null = null;
  // Set ONLY on the no-row (local-manifest, no server row) path so its structured
  // mint-audit log (`blocks.dev-token.local-mint`) can fire — like the pending
  // path it has NO durable AppBlock-backed audit rows (the synthetic appId /
  // appBlockId don't resolve), so the log is the only forensic trail.
  let localManifestSlug: string | null = null;

  if (block && block.app && block.app.userId === user.id) {
    // Owned approved row → existing-app mode. But an OWNED-yet-not-approved row
    // (e.g. status: pending with an appBlockId already linked) is NOT live: the
    // dev-token mint resolves a DEPLOYED instance. Surface the ACTIONABLE
    // no-live-deployment message (owner-only) instead of the bare "App not found".
    if (block.status !== 'approved') {
      res.status(404).json({
        message:
          `block '${block.blockId}' has no live deployment — dev:live requires an ` +
          `approved + deployed version (deployState: live). Until your first ` +
          `version is live, validate locally with dev:harness (mock).`,
      });
      return;
    }
    // The app MUST declare a page block — dev-token mints PAGE tokens only (the
    // live-local target is a page app; no model binding).
    const manifest = (block.manifest ?? {}) as { page?: unknown };
    if (
      typeof manifest.page !== 'object' ||
      manifest.page === null ||
      Array.isArray(manifest.page)
    ) {
      res
        .status(422)
        .json({ message: 'dev-token mints page tokens; this app declares no page block' });
      return;
    }
    const approvedRaw: unknown[] = Array.isArray(block.approvedScopes)
      ? block.approvedScopes
      : [];
    resolved = {
      scopeSource: approvedRaw.filter((s): s is string => typeof s === 'string'),
      oauthAllowed: block.app.allowedScopes ?? 0,
      signBlockId: block.blockId,
      signAppId: block.appId,
      signAppBlockId: block.id,
      // Synthetic, revocable PAGE instance id — same shape as the prod page mint.
      // NOTE (revocation-wiring caveat): dev page tokens share the
      // `page_<appBlockId>` instanceId shape with PRODUCTION page mints. The
      // revocation WRITE path (block-revocation.service.ts revokeInstance /
      // clearInstance) is currently UNWIRED (no callers). If it is ever wired,
      // dev instance ids on THIS path must be namespaced distinctly (e.g.
      // `devpage_`) and/or the revocation marker TTL must cover the 4h dev token
      // lifetime — otherwise a dev revocation (or a 4h marker) would bleed into
      // production page tokens for the SAME app (collision on `page_<appBlockId>`).
      blockInstanceId: `${PAGE_INSTANCE_PREFIX}${block.id}`,
    };
  } else if (slug) {
    // 6b. LOCAL-MANIFEST path (Phase 4). Reached ONLY when no owned approved row
    // exists AND the caller passed a `slug` (pending apps have NO appBlockId, so
    // an `appBlockId`-only request can never reach here). Find the caller's OWN
    // pending submission for this slug. dbWrite (no replica lag). OWNERSHIP is
    // enforced in the query (`submittedByUserId === user.id`) so the row is, by
    // construction, the caller's — we never read another user's pending row.
    const pending = await dbWrite.appBlockPublishRequest.findFirst({
      where: { slug, status: 'pending', submittedByUserId: user.id },
      orderBy: { submittedAt: 'desc' },
      select: { id: true, slug: true, manifest: true },
    });
    if (pending) {
      // The un-reviewed manifest MUST declare a page block — same 422 as the
      // approved path (dev-token mints page tokens only).
      const manifest = (pending.manifest ?? {}) as { page?: unknown; scopes?: unknown };
      if (
        typeof manifest.page !== 'object' ||
        manifest.page === null ||
        Array.isArray(manifest.page)
      ) {
        res
          .status(422)
          .json({ message: 'dev-token mints page tokens; this app declares no page block' });
        return;
      }
      const manifestScopesRaw: unknown[] = Array.isArray(manifest.scopes) ? manifest.scopes : [];
      pendingPublishRequestId = pending.id;
      resolved = {
        // Scope SOURCE is the UN-REVIEWED manifest.scopes (§4 R1) — clamped by the
        // IDENTICAL belt below (allowlist + page-forbidden + 7f spend ceiling).
        scopeSource: manifestScopesRaw.filter((s): s is string => typeof s === 'string'),
        // No OauthClient for a pending app → SKIP the OAuth-ceiling clamp. Passing
        // 0 would WRONGLY strip every non-SKIP_OAUTH_CHECK scope (`(0 & bit) !== bit`);
        // the correct substitute ceiling is the dev's OWN credential, enforced at
        // step 7f (AIServicesWrite spend gate). 7f IS the spend gate here.
        oauthAllowed: null,
        signBlockId: pending.slug,
        // SYNTHETIC, NON-COLLIDING appId (audit S1 fix). A pending app has NO
        // OauthClient yet, so there is no real client id to bind. We DELIBERATELY
        // do NOT use the deterministic `appblk-<slug>` id an approved app WOULD
        // get: that string is the id a real APPROVED app owned by ANOTHER user
        // may already hold (the submit guard blocks only same-slug *pending*
        // collisions, not pending-vs-approved). Minting `appblk-<slug>` here would
        // let recordSpendAttribution's `oauthClient.findUnique({ where: { id } })`
        // (buzz-attribution.service.ts) RESOLVE the victim's real client and write
        // a foreign `blockSpendAttribution` row (status='tracked',
        // appOwnerUserId=<victim>, real grossValueCents) — the exact row the
        // deferred payout rail (#2605 Slice-4 backpay) reads to pay
        // `gross × spendSharePct`. Dormant today (spendSharePct=0) but a forged
        // accrual ledger would persist into the payout window.
        //
        // Instead use `pending-<publishRequestId>` — `pubreq_<ULID>` ids make this
        // `pending-pubreq_<ULID>`, which can NEVER match an `appblk-*` id NOR a
        // real `OauthClient.id` shape. The attribution lookup MISSES → it hits the
        // intended inert `if (!app)` skip-write path (throws
        // AttributionAppMissingError, swallowed by the void/catch at
        // blocks.router.ts:2449) — correct: a pending dev-test spend has no
        // approved app to attribute to, so NO row is written. `appId` has no other
        // load-bearing use on the pending path: it's only (a) a cosmetic workflow
        // TAG `app-block:${appId}` (blocks.router.ts:2978 — orchestrator bills
        // getOrchestratorToken(userId)), (b) this attribution lookup we WANT to
        // miss, and (c) middleware string-type validation (block-scope.middleware
        // .ts:393). No FK resolves `appId` on the pending path.
        signAppId: `pending-${pending.id}`,
        // No AppBlock.id exists — use the pending request id (stable, unique per
        // submission). The JWT `appBlockId` claim is only string-validated by the
        // middleware (block-scope.middleware.ts:394). NOTE: the best-effort
        // BlockScopeInvocation audit-log write (a NOT-NULL FK → AppBlock.id) will
        // FK-fail for this value and is silently swallowed (fire-and-forget,
        // catch-all) — acceptable, documented residual; verification + revocation
        // are unaffected.
        signAppBlockId: pending.id,
        // Stable, BlockRevocation-checkable synthetic instance id derived from the
        // publish-request id (no AppBlock.id to key on).
        blockInstanceId: `${PAGE_INSTANCE_PREFIX}pubreq_${pending.id}`,
      };
    } else if (block == null) {
      // 6c. NO-ROW (local-manifest) path (Phase 4 — deferred mode). Reached ONLY
      // when: a `slug` was passed, NO approved AppBlock exists for it AT ALL
      // (`block == null`), AND no caller-owned pending request was found. This
      // mints a `dev:live` token for a BRAND-NEW app the dev has NOT submitted —
      // there is no server row of any kind, so the scope SOURCE is the
      // CLIENT-SUPPLIED body `scopes` (the dev's local manifest, sent by the CLI).
      //
      // GUARD (NO-SHADOW): the `block == null` condition is load-bearing. A
      // foreign-owned APPROVED row (`block` non-null, owner !== caller) does NOT
      // enter this branch — it falls through to the bare 404 below, so a dev can
      // never mint a "local" token for a slug a real published app owns (no
      // shadowing / attribution confusion). Only the genuine no-such-row case
      // reaches here.
      //
      // The body scopes ARE the source (un-reviewed, developer-controlled — the
      // strongest §4 R1 surface), clamped by the IDENTICAL belt below minus the
      // OAuth ceiling (no OauthClient → `oauthAllowed: null`; 7f is the spend
      // gate). Page-only by construction (no server manifest to inspect; dev-token
      // mints page tokens only). An empty/absent body `scopes` → an empty source →
      // a read-only token after the force-grant (not a 404).
      localManifestSlug = slug;
      resolved = {
        // SCOPE SOURCE = the client-supplied body scopes. The body-narrowing step
        // (7e) intersects `granted` with `requestedScopes`; since here the source
        // IS `requestedScopes`, that intersection is an identity no-op (it cannot
        // empty the set beyond what the belt already strips). Use the same array.
        scopeSource: requestedScopes ?? [],
        // No OauthClient → SKIP the OAuth-ceiling clamp (passing 0 would wrongly
        // strip every non-skip scope). 7f (AIServicesWrite) is the spend gate.
        oauthAllowed: null,
        signBlockId: slug,
        // SYNTHETIC, NON-RESOLVING appId (audit S1 parity). `local-<slug>` can
        // NEVER equal a UUIDv4 user-created OauthClient.id NOR an `appblk-<slug>`
        // App-Blocks client id, so recordSpendAttribution's
        // `oauthClient.findUnique({ id })` MISSES → the inert skip-write path →
        // no forged blockSpendAttribution row.
        signAppId: `${LOCAL_APP_ID_PREFIX}${slug}`,
        // No AppBlock.id exists — synthetic `page_local_<slug>` (string-validated
        // only by the middleware; the best-effort BlockScopeInvocation audit-log
        // write FK-fails on it and is silently swallowed — documented residual,
        // identical to the pending path).
        signAppBlockId: `page_local_${slug}`,
        // Stable, BlockRevocation-checkable synthetic instance id.
        blockInstanceId: `${PAGE_INSTANCE_PREFIX}local_${slug}`,
      };
    }
  }

  // No owned approved AppBlock AND no owned pending request → the SAME bare 404
  // as the approved path. We never reveal existence/ownership/state of a row the
  // caller doesn't own (no probe oracle). Note an OWNED-but-not-approved row
  // already returned its own actionable 404 above; an OWNED pending row resolved.
  if (!resolved) {
    res.status(404).json({ message: 'App not found' });
    return;
  }

  // 7. SCOPE CLAMP + 8. BUDGET CAP — the AUDITED belt, now factored into the
  // shared `dev-scoped-mint.service` so the Phase-2 cookie-authed host-mint branch
  // (`/api/v1/block-tokens`) reuses the IDENTICAL logic instead of a parallel
  // re-implementation. Start from the resolved scope SOURCE — the app's APPROVED
  // snapshot (existing-app) OR the OWNED pending request's un-reviewed
  // manifest.scopes (pending local-manifest, §4 R1) OR the CLIENT-SUPPLIED body
  // scopes (no-row local-manifest, §4 R1) — then apply the IDENTICAL belt:
  //   a) keep only KNOWN block scopes,
  //   b) keep only scopes within the DEV_TOKEN_SCOPE_ALLOWLIST (excludes
  //      social:tip:self + block:settings:*; INCLUDES apps:storage:* for THIS
  //      bearer path — the tunnel path uses TUNNEL_HOST_MINT_SCOPE_ALLOWLIST which
  //      strips storage, Decision 1),
  //   c) keep only scopes within the app's OAuth ceiling (allowedScopes) — ONLY
  //      for the approved path (`oauthAllowed !== null`); OMITTED for both
  //      local-manifest paths (no OauthClient),
  //   d) drop the PAGE_FORBIDDEN money/spend scopes (the page hard rule),
  //   e) if the body requested a subset, intersect with it,
  //   f) BEARER-CREDENTIAL SPEND CEILING (`keyCanSpend`): strip `ai:write:budgeted`
  //      unless the bearer credential (personal key OR OAuth consent) carries
  //      AIServicesWrite. `session.tokenScope` is the resolved bitmask for BOTH
  //      shapes. `AppBlocksSubmit` is the MINT gate (step 1b), `AIServicesWrite`
  //      the SPEND gate — never conflated.
  //   g) force-grant `user:read:self` (self-bound read of the dev's OWN identity;
  //      `/blocks/me` for the harness viewer). SAFE: the token `sub` is ALWAYS the
  //      authenticated caller (never the body), so it can only return the caller's
  //      own profile — no third-party data, no write, no spend.
  // Every step is a STRIP (no error) so a partially-disallowed request still mints
  // a usable, safely-clamped token. This bearer path is UNCHANGED by the
  // extraction (a parity test locks it).
  const keyCanSpend = Flags.hasFlag(session.tokenScope ?? 0, TokenScope.AIServicesWrite);
  const granted = clampDevScopes({
    scopeSource: resolved.scopeSource,
    oauthAllowed: resolved.oauthAllowed,
    requestedScopes,
    keyCanSpend,
    allowlist: DEV_TOKEN_SCOPE_ALLOWLIST,
  });

  // 8. BUDGET CAP — only meaningful when ai:write:budgeted survived the clamp.
  const buzzBudget = resolveDevBuzzBudget(granted, requestedBudget);

  // 8b. PENDING-PATH MINT AUDIT (FIX 🟡-1). The pending (local-manifest) path is
  // the ONLY mint without durable, queryable audit rows: recordSpendAttribution
  // throws+swallows on the synthetic `pending-<id>` appId, and recordScopeInvocation
  // FK-fails on the synthetic `appBlockId` (no AppBlock row). Without this, a dev
  // minting a spend-capable token against an UN-REVIEWED app leaves no forensic
  // trail. Emit a structured event (Axiom/Loki-queryable) with the mint metadata —
  // NEVER the token/secret. Placed AFTER the final scope clamp + budget resolution
  // so `scopes`/`spendGranted` reflect the actual minted outcome (7f clamp included).
  // PENDING-PATH ONLY: the approved path already has durable AppBlock-backed audit
  // rows (recordSpendAttribution / recordScopeInvocation persist there), so it does
  // not emit this event. The `mode: 'pending'` field is carried so a future
  // approved-side log could reuse the same schema.
  if (pendingPublishRequestId) {
    req.log?.info('blocks.dev-token.pending-mint', {
      mode: 'pending',
      userId: user.id,
      slug: resolved.signBlockId,
      publishRequestId: pendingPublishRequestId,
      scopes: granted,
      spendGranted: granted.includes('ai:write:budgeted'),
    });
  } else if (localManifestSlug) {
    // NO-ROW (local-manifest) MINT AUDIT. Same rationale as the pending path:
    // the synthetic `local-<slug>` appId / `page_local_<slug>` appBlockId don't
    // resolve, so there are NO durable AppBlock-backed audit rows — this
    // structured event (Axiom/Loki-queryable, NEVER the token/secret) is the only
    // forensic trail for a no-row mint. Placed after the final clamp + budget so
    // `scopes`/`spendGranted` reflect the actual minted outcome (7f included).
    req.log?.info('blocks.dev-token.local-mint', {
      mode: 'local',
      userId: user.id,
      slug: localManifestSlug,
      scopes: granted,
      spendGranted: granted.includes('ai:write:budgeted'),
    });
  }

  // 9. The synthetic, revocable PAGE instance id was resolved in step 6:
  //    - approved path:  `page_<appBlockId>` (same shape as the prod page mint),
  //    - pending path:   `page_pubreq_<publishRequestId>` (stable, unique),
  //    - no-row path:    `page_local_<slug>` (stable, unique per slug).
  // All are BlockRevocation-checkable; the harness token-handling is identical.
  const blockInstanceId = resolved.blockInstanceId;

  // 10–11. SIGN — the shared belt builds the PAGE ctx (entity=none, no model
  // binding — byte-identical to the prod page mint) and reuses
  // BlockTokenService.sign VERBATIM: self-bound sub (userId), forced-SFW ceiling,
  // dev-capped budget, `dev: true` (4h lifetime + `dev` claim; the verifier keys
  // the 4h max-age cap off it, leaving every PRODUCTION token at 15min).
  //
  // BLAST RADIUS of the 4h lifetime — the token carries NO mod claim, so the
  // mint-TIME moderator check (step 2) does NOT bound it. What bounds the
  // money/settings paths is the LIVE per-request moderator re-check
  // (`assertViewerIsModerator` in apps.router / blocks.router): a demoted/banned
  // mod's 4h token is rejected there as soon as the demotion lands. The token is
  // further self-bound, per-call budget capped, and forced-SFW.
  const result = await signDevScopedPageToken({
    userId: user.id,
    signBlockId: resolved.signBlockId,
    signAppId: resolved.signAppId,
    signAppBlockId: resolved.signAppBlockId,
    blockInstanceId,
    granted,
    buzzBudget,
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
