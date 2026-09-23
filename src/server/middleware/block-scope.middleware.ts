import { decodeProtectedHeader, jwtVerify } from 'jose';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import {
  ensureRegisterAppBlockRuntimeMetrics,
  recordBlockRestApprovalVerdict,
  recordBlockRevocationRefusal,
  statusToRequestResult,
  type AppBlockEndpoint,
} from '~/server/metrics/app-block-runtime.metrics';
import { isAppBlocksRuntimeEnabled } from '~/server/services/app-blocks-flag';
import { resolveRestApprovalVerdict } from '~/server/services/blocks/block-approval.service';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import {
  BLOCK_TOKEN_AUDIENCE,
  BLOCK_TOKEN_ISSUER,
  DEV_TOKEN_LIFETIME_SECONDS,
  getBlockTokenVerificationKeysByKid,
} from '~/server/services/block-token.service';
import { ANON_SUBJECT, isValidSubject, USER_SUB_RE } from '~/server/services/block-token-subject';
import { isKnownBlockScope } from '~/shared/constants/block-scope.constants';
import {
  isBlockActionDetail,
  type BlockActionDetail,
} from '~/shared/constants/block-action-detail';

/**
 * Block-scope middleware — wraps a Next.js API handler with block JWT
 * validation, scope enforcement, context binding, and CORS.
 *
 * Behavior matrix:
 *   - No Authorization: Bearer header           → fall through to existing handler (session auth)
 *   - Authorization: Bearer <opaque API key>    → fall through (legacy API key path)
 *   - Authorization: Bearer <RS256 block JWT>   → validate, bind to context, set req.blockClaims
 *
 * See docs/features/app-blocks.md for the overall architecture.
 */

export interface BlockTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  blockId: string;
  appId: string;
  /**
   * AppBlock.id (`apb_<ulid>`). Distinct from `appId` which is the
   * OauthClient.id. Used to write BlockScopeInvocation rows without
   * a per-request DB lookup.
   */
  appBlockId: string;
  blockInstanceId: string;
  ctx: Record<string, unknown>;
  scopes: string[];
  /**
   * The per-call generation ceiling the app declared (`page.buzzBudgetPerGen` /
   * `settings.buzz_budget_per_gen`), clamped by the minting resolver.
   *
   * 🔴 A SUBMIT GATE READS IT ONLY THROUGH `blockPerCallBudget` — see that
   * function for what the indirection is and is not doing today. The read
   * surfaces that merely REPORT the number to the block (`/api/v1/blocks/me`,
   * `blocks.getMyViewer`) project it directly and are ledgered as such in
   * `src/server/services/__tests__/no-direct-block-budget-claim-read.test.ts`.
   */
  buzzBudget?: number;
  /**
   * AUTHORITATIVE color-domain maturity ceiling (bitwise browsing-level flag,
   * from `domainBrowsingCeiling`) stamped at mint. The block generation path
   * derives `allowMatureContent` from this — never from a client body field.
   * ABSENT on legacy tokens minted before the maturity feature → consumers
   * MUST fail closed (treat as SFW). The block catalog endpoints
   * (/api/v1/blocks/models, /api/v1/blocks/images) likewise intersect the
   * requested browsing level with this ceiling so a SFW-domain token can never
   * widen to mature catalog content.
   */
  maxBrowsingLevel?: number;
  /** Advisory: the color domain the token was minted on (`green`|`blue`|`red`). */
  domain?: string;
  /**
   * DEV-TOKEN marker. ⚠️ THIS USED TO SAY "ONLY on tokens minted by the mod-gated
   * dev-token endpoint (`/api/v1/blocks/dev-token`) for the `dev:live` localhost
   * harness", and that is wrong in the direction that matters: the claim is stamped
   * unconditionally by `signDevScopedPageToken`, which is reached by SIX mint paths
   * across `/api/v1/blocks/dev-token` (approved / pending / local-manifest),
   * `/api/v1/block-tokens` (ephemeral tunnel / owner-non-approved tunnel) and the tRPC
   * review-sandbox mint. So `dev === true` identifies a LIFETIME class, not a caller and
   * not a capability — reading it as "the dev:live harness" is how a guard came to exempt
   * all six from the approved-status check (clawgate #571). Anything deciding
   * AUTHORIZATION on this claim must narrow it further; see
   * `resolveAppBlockApprovalVerdict` for the population table.
   * It selects the per-token-type max-age cap in `verifyBlockToken`
   * (4h for dev, 15min for every other token). The claim is only trustworthy
   * BECAUSE the signature (RS256, our kid) is verified before it's read — a
   * forged `dev:true` can't pass the signature gate. The claim is optional and
   * MUST be a boolean if present; an absent OR non-boolean `dev` fails safe to
   * the SHORTER 15min cap (and a non-boolean is rejected outright).
   */
  dev?: boolean;
  /**
   * MOD REVIEW SANDBOX "run for real" marker (#2831) — present (true) ONLY on a
   * token minted by `mintReviewBlockToken({ runForReal: true })` (a moderator's
   * consent-gated opt-in). The runtime spend paths (submitWorkflow / customComfy)
   * read it to enforce the TIGHT per-(mod, publishRequestId) AGGREGATE Buzz
   * ceiling instead of the ordinary per-user daily cap. Trustworthy ONLY because
   * the RS256 signature is verified before it is read. Optional; MUST be a boolean
   * if present (a non-boolean is rejected outright; absent → treated as false).
   */
  reviewRunForReal?: boolean;
}

/**
 * THE per-call Buzz ceiling a submit gate compares against.
 *
 * ── WHAT IT DOES TODAY: NOTHING A CALLER COULD NOT DO INLINE ────────────────
 * It returns `claims.buzzBudget`, or 0 when no budget was minted. BOTH values of
 * `pricesAuthorFee` return that same number. Routing the four submit gates
 * through it is a no-op on behaviour, and that is the entire intent: it
 * consolidates four copies of one comparison without altering any of them.
 *
 * ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────
 * The four gates spell the same comparison and are NOT interchangeable. Two of
 * them add the per-generation author fee into the value they compare; two do not,
 * because neither has a pre-submit `cost.base` to price a fee from (that split is
 * documented at `src/server/services/blocks/author-fee-charge.service.ts` and
 * ledgered in `src/server/services/__tests__/no-divergent-author-fee-base.test.ts`).
 * Any future change to the ceiling is correct for at most one of those two
 * populations, so it has to be made somewhere that knows which gate is which.
 * This is that place; `pricesAuthorFee` is how each gate declares which it is.
 *
 * 🔴 THE FLAG IS CLASSIFICATION ONLY, AND HAS NO EFFECT. It changes no value, no
 * branch reads it, and there is no ceiling decision behind it yet. A gate passing
 * the "wrong" one is therefore not a defect today, because nothing consumes it.
 * Do not read its presence as evidence that a difference exists. It is pinned
 * against the fee call sites by
 * `src/server/services/__tests__/no-direct-block-budget-claim-read.test.ts` so the
 * classification cannot drift out of step with the fee before it becomes
 * load-bearing — which it does the moment any branch reads it.
 *
 * 🔴 A RAISED CEILING WAS PROPOSED HERE AND WITHDRAWN. Minting `buzzBudget` ABOVE
 * the declared ceiling so a fee fits underneath it is sound only where the fee is
 * inside the compared value, and it was unsound in two ways at once. On the two
 * fee-free gates the number that clears the gate is the number reserved and
 * billed, so a raised ceiling spends real viewer Buzz above the ceiling the app's
 * manifest declared. And on a fee-pricing gate it is equally unsound whenever the
 * fee prices to zero — which it does for at least one generation type today — so
 * the headroom is generation headroom no fee ever consumes. The manifest schema
 * describes that declared number to authors as a safety ceiling against a
 * compromised app draining the viewer's Buzz, so exceeding it is the one thing it
 * must not do.
 *
 * So a future raised ceiling has to arrive as a SEPARATE claim whose name says it
 * is granted, read only by a gate that prices the fee into its compared value —
 * never by widening what `buzzBudget` means, which would hand the money-unsafe
 * value to every gate written the obvious way.
 *
 * Returns 0 when no budget was minted, so a caller that skipped the
 * `typeof claims.buzzBudget !== 'number'` pre-check still fails CLOSED.
 */
export function blockPerCallBudget(
  claims: Pick<BlockTokenClaims, 'buzzBudget'>,
  // Classification only, read by no branch today — see the note above. Kept in
  // the signature so each gate declares its population and the ledger can pin
  // that declaration against the fee call sites. The directive must stay on the
  // line immediately above the parameter: anything between them and it silently
  // applies to the comment instead.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts: { pricesAuthorFee: boolean }
): number {
  if (typeof claims.buzzBudget !== 'number') return 0;
  return claims.buzzBudget;
}

export type BlockScopedNextApiRequest = NextApiRequest & {
  blockClaims?: BlockTokenClaims;
};

/**
 * W13 richer audit detail — a mutation handler wrapped by `withBlockScope`
 * (tip, shared-storage increment, …) stashes a structured `BlockActionDetail`
 * on the response so the finish-writer below can include it on the audit row
 * WITHOUT a second write path. The middleware is the SINGLE writer; the handler
 * only annotates. Reads never stash — their label is derived from `scope` at
 * render time.
 *
 * 🔴 Best-effort by construction: `stashBlockActionDetail` can NEVER throw into
 * the handler's money path (it swallows), and `readBlockActionDetail` narrows a
 * possibly-absent/garbage value defensively. A missing or malformed stash simply
 * writes a plain (detail-less) row.
 */
const BLOCK_ACTION_DETAIL_KEY = '__civitaiBlockActionDetail';

export function stashBlockActionDetail(res: NextApiResponse, detail: BlockActionDetail): void {
  try {
    if (isBlockActionDetail(detail)) {
      (res as unknown as Record<string, unknown>)[BLOCK_ACTION_DETAIL_KEY] = detail;
    }
  } catch {
    /* audit annotation is best-effort — never let it perturb the response */
  }
}

export function readBlockActionDetail(res: NextApiResponse): BlockActionDetail | undefined {
  try {
    const stashed = (res as unknown as Record<string, unknown>)[BLOCK_ACTION_DETAIL_KEY];
    return isBlockActionDetail(stashed) ? stashed : undefined;
  } catch {
    return undefined;
  }
}

export interface WithBlockScopeOpts {
  /**
   * Low-cardinality LOGICAL name for this endpoint (e.g. 'tip', 'me',
   * 'model_detail', 'collections', 'shared_storage_top'). Used as the `endpoint` label on the
   * per-app REST-RED metrics (`civitai_app_block_requests_total` /
   * `civitai_app_block_request_duration_seconds`). Never derived from `req.url`,
   * so ids in the path can never leak into the label. Strictly enumerated — see
   * AppBlockEndpoint in ~/server/metrics/app-block-runtime.metrics. (A call site
   * may pass a resolver — see below — so this is no longer purely
   * handler-derived; what holds is that the value set stays enumerated.)
   *
   * A FUNCTION may be passed when one path serves two materially different
   * workloads and merging them would make the RED series unreadable — today
   * only `blocks/tools`, whose GET is a static registry read and whose POST is
   * a catalog search. It is resolved per request and its return type is the
   * same strict union, so this cannot become a channel for `req.url`: the call
   * site still has to name every value it can produce.
   *
   * 🔴 NOT a general "label from the request" hook. Anything derived from
   * client-controlled input belongs nowhere near this label — that is the whole
   * reason it is enumerated and handler-derived.
   */
  endpoint: AppBlockEndpoint | ((req: NextApiRequest) => AppBlockEndpoint);

  /**
   * The block scope this endpoint requires. When PRESENT, the middleware
   * enforces `claims.scopes.includes(requiredScope)` (403 on miss) AND runs
   * `enforceContextBinding` for the token's scopes — the standard per-scope
   * authorization path (me.ts, submit-version, settings, etc.).
   *
   * When OMITTED ("any valid block token" mode), the middleware STILL performs
   * the FULL token validation (RS256 signature + kid, iss/aud/exp, max-age,
   * the claim shape guards incl. `maxBrowsingLevel`), the per-instance
   * revocation check, the `private, no-store` cache header, and exact-origin
   * CORS — it ONLY skips the per-scope authorization check and
   * `enforceContextBinding`. Anonymous callers (no token / non-JWT bearer) are
   * still rejected (the wrapped handler's own 401 guard fires).
   *
   * This mode exists for the block CATALOG endpoints (/api/v1/blocks/models,
   * /api/v1/blocks/images): they serve PUBLIC, maturity-clamped data, so a
   * specific declarable+grantable scope adds friction (CLI manifest validator +
   * per-app OauthClient.allowedScopes bit) with no security value. They need a
   * token ONLY for its signed `maxBrowsingLevel` claim — the authoritative
   * maturity ceiling source — NOT for authorization. Token validity + the
   * clamp (resolveCatalogBrowsingLevel, fail-closed SFW) is the whole authority
   * surface; the scope gate would add nothing.
   */
  requiredScope?: string;

  /**
   * WHAT THIS ROUTE DOES WHEN THE APPROVED-STATUS READ **FAILS** (verdict
   * `lookup_failed` — the replica threw, so we do not know whether the app is
   * allowed to run). ABSENT = refuse with 503, i.e. FAIL CLOSED, which is the
   * default for every route that does not opt out and the right default for a
   * route added later by someone who has not read this.
   *
   * `'serve'` opts a route into serving the request instead. It is still COUNTED
   * (`reason="lookup_failed"`) and still logged — only the response changes.
   *
   * 🔴 WHY ANY ROUTE OPTS OUT, and it is an AVAILABILITY argument, not a security
   * one. This read is new: before the approved-status gate the catalog routes made
   * no DB read at all. Failing them closed therefore does not restore some previous
   * posture — it INTRODUCES a coupling from every block REST route to one replica,
   * and a replica blip becomes a fleet-wide, simultaneous 503 for every block at
   * once. On a route where refusing removes no exposure, that trade is all cost.
   *
   * 🔴 IT IS THE SAME ARGUMENT THE `not_found` BRANCH ALREADY WON, applied to the
   * other verdict that is not a takedown. Every moderator takedown leaves a row
   * whose status is not `approved`, so 100% of this gate's protective value is in
   * `not_approved` — which is NOT opt-outable here and never refuses less. A read
   * that failed is not evidence of a takedown; it is evidence of an infra problem.
   *
   * 🔴 WHERE IT MAY BE USED, AND THE TEST IS EXPOSURE, NOT CONVENIENCE. Only on a
   * route where a suspended app reaching the handler obtains nothing it could not
   * obtain anyway. The set is asserted in BOTH directions, with a written rationale
   * per entry, in `no-unguarded-block-rest-token.test.ts`
   * (`LOOKUP_FAILURE_SERVE_RATIONALE`) — a route cannot quietly join or leave it.
   * Do NOT add it to a route that spends, writes, or discloses anything scoped to
   * the viewer; `tip.ts` is the worked counter-example and must always 503 here.
   *
   * ⚠️ NOT derivable from `requiredScope`, and that was the first thing tried. The
   * no-exposure set is NOT the no-`requiredScope` set: `models/[id]` declares
   * `requiredScope: 'models:read:self'` and is nevertheless the CLEAREST no-exposure
   * case in the table (dual-auth — an anonymous caller already gets the same body),
   * while the four unscoped catalog routes are a weaker version of the same argument
   * (public but maturity-clamped per token). One is a scope declaration and the
   * other is a statement about what the body discloses; they are different questions
   * that happen to correlate, so the declaration is explicit here rather than
   * inferred from a proxy that is wrong on the most important entry.
   */
  onApprovalLookupFailure?: 'serve';

  /**
   * Opt-in: answer CORS for an OPAQUE-origin caller (`Origin: null`) by echoing
   * `Access-Control-Allow-Origin: null`.
   *
   * WHY: UNVERIFIED App Blocks are sandboxed WITHOUT `allow-same-origin` (see
   * `src/components/AppBlocks/sandbox.ts` — only internal/verified tiers get
   * it), so the iframe runs at an OPAQUE origin and every `fetch` it makes
   * sends `Origin: null`. `null` can never be in the OauthClient.allowedOrigins
   * allowlist, so a direct (non-bridge) fetch's CORS preflight falls through to
   * the handler and 405s — the in-block resource browser (or collections / tip /
   * shared-storage rail) then can't load. (First hit by the catalog
   * selector; the collections, tip, and shared-storage REST endpoints a
   * block direct-fetches hit the SAME wall.)
   *
   * SAFE wherever authorization rests SOLELY on the Bearer block-JWT with NO
   * ambient/cookie credential — which is every block REST endpoint, so this is
   * set on both the PUBLIC catalog endpoints (/api/v1/blocks/{models,images})
   * and the per-user scoped ones (collections/tip/shared-storage). Block
   * iframes carry no civitai cookie and `Access-Control-Allow-Credentials` is
   * omitted, so `ACAO: null` grants NO tokenless access: the real request still
   * requires a valid short-lived block JWT in `Authorization` (an attacker's own
   * null-origin sandboxed page can't mint one), and per-user responses are bound
   * to the token's SUBJECT — the preflight is CORS POLICY only; the token is the
   * gate, not CORS. That is why it stays an explicit per-endpoint opt-in and not
   * blanket middleware behavior. Do NOT set it on any endpoint that would
   * authorize via an AMBIENT credential (a civitai session cookie) — there
   * `ACAO: null` could let a sandboxed page read a per-user response WITHOUT
   * presenting a token. (No block endpoint reads cookies today; the catalog
   * endpoints additionally return only PUBLIC maturity-clamped data.)
   */
  allowOpaqueOrigin?: boolean;
}

// L7 (audit-10): issuer/audience imported from block-token.service so a
// typo in one file can't desynchronize sign-vs-verify.

/**
 * Normalize an origin for matching: lowercase scheme + host, drop any path
 * component, drop trailing slashes. Avoids surprises from
 * `https://Example.com/` in env vs. browser `https://example.com`.
 */
function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

// W11 quick win (2026-05-30): the allowlist is the UNION of
//   (a) BLOCK_ALLOWED_ORIGINS env CSV (transition-shim — apps that pre-date
//       OauthClient.allowedOrigins population can still be listed here).
//   (b) every approved OauthClient row's allowedOrigins[] column — written
//       by the W1 publish-request approve handler when a new app is born.
//
// In-memory cache with a 60s TTL handles the bulk of traffic without a
// per-request DB hit; the refresh-on-miss path takes the hit at most once
// per minute per pod. No Redis layer because (a) the set is small (one
// entry per app), (b) the cost of going stale for 60s is bounded (a fresh
// app waits a minute before its iframe can postMessage, and the env-CSV
// can be used to skip the wait when needed).
type OriginCacheEntry = { origins: Set<string>; expiresAt: number };
const ORIGIN_CACHE_TTL_MS = 60_000;
let _allowedOriginsCache: OriginCacheEntry | null = null;
let _allowedOriginsInflight: Promise<Set<string>> | null = null;

function envOrigins(): string[] {
  const raw = env.BLOCK_ALLOWED_ORIGINS ?? '';
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const norm = normalizeOrigin(trimmed);
    if (norm) out.push(norm);
  }
  return out;
}

async function loadAllowedOrigins(): Promise<Set<string>> {
  const next = new Set<string>(envOrigins());
  try {
    // Dynamic import so this module's load-time side effects don't drag
    // the full Prisma client in. Middleware code paths that never reach
    // a CORS preflight check (test harnesses, tooling) shouldn't need
    // a configured DB to import this file.
    const { dbRead } = await import('~/server/db/client');
    const rows = (await dbRead.oauthClient.findMany({
      // The isEmpty=false filter skips test clients that exist with no
      // allowedOrigins populated yet. Postgres-specific but Prisma
      // exposes it via the standard array filter shape.
      where: { allowedOrigins: { isEmpty: false } },
      select: { allowedOrigins: true },
    })) as Array<{ allowedOrigins: string[] }>;
    for (const row of rows) {
      for (const o of row.allowedOrigins ?? []) {
        const norm = normalizeOrigin(o);
        if (norm) next.add(norm);
      }
    }
  } catch (err) {
    // DB unreachable shouldn't lock all blocks out — fall back to the env
    // CSV alone. Log once per stale cache window so ops can see it.
    // eslint-disable-next-line no-console
    console.warn(
      `[block-scope] OauthClient origin lookup failed; falling back to env-only set: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return next;
}

async function getAllowedOriginsAsync(): Promise<Set<string>> {
  const now = Date.now();
  const cached = _allowedOriginsCache;
  if (cached && cached.expiresAt > now) return cached.origins;
  // Single-flight: if a refresh is already in progress, await it rather
  // than launching N parallel DB queries on a cold start under load.
  if (_allowedOriginsInflight) return _allowedOriginsInflight;
  _allowedOriginsInflight = loadAllowedOrigins()
    .then((set) => {
      _allowedOriginsCache = { origins: set, expiresAt: Date.now() + ORIGIN_CACHE_TTL_MS };
      return set;
    })
    .finally(() => {
      _allowedOriginsInflight = null;
    });
  return _allowedOriginsInflight;
}

/**
 * Test-only: clear the in-memory cache so a unit test can swap the
 * underlying OauthClient mock without waiting 60s. Not exported via the
 * public surface (block-scope.middleware module export); reach via
 * `(_internalsForTests as any).resetOriginCache()` if you need it.
 */
export const _internalsForTests = {
  resetOriginCache(): void {
    _allowedOriginsCache = null;
    _allowedOriginsInflight = null;
  },
};

async function originAllowed(origin: string | undefined): Promise<boolean> {
  if (!origin) return false;
  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  const set = await getAllowedOriginsAsync();
  return set.has(norm);
}

// Bounded LRU of origins we've already warned about, so a flood of unique
// unrecognized origins can't grow the set without bound.
const WARNED_ORIGINS_MAX = 128;
const warnedOrigins = new Set<string>();
function rememberWarnedOrigin(origin: string) {
  if (warnedOrigins.has(origin)) return false;
  if (warnedOrigins.size >= WARNED_ORIGINS_MAX) {
    const oldest = warnedOrigins.values().next().value;
    if (oldest) warnedOrigins.delete(oldest);
  }
  warnedOrigins.add(origin);
  return true;
}

/**
 * Sets block-CORS headers when the origin is in the allowlist (union of
 * `BLOCK_ALLOWED_ORIGINS` env CSV + every approved OauthClient's
 * `allowedOrigins[]` — W11 dynamic-lookup landed 2026-05-30).
 *
 * Returns true ONLY when we've fully handled the request (block-origin preflight).
 * In every other case — including OPTIONS from origins we don't recognize —
 * returns false so the caller falls through to the wrapped handler's own
 * CORS path. This preserves the pre-PR behavior of routes like
 * /api/v1/models/[id] (which set ACAO: * in PublicEndpoint) for browser
 * integrations doing CORS preflight from origins outside our allowlist.
 */
async function setBlockCors(
  req: NextApiRequest,
  res: NextApiResponse,
  opts: WithBlockScopeOpts
): Promise<'handled' | 'fallthrough'> {
  const origin = req.headers.origin;
  const isAllowed = await originAllowed(origin);

  if (isAllowed && origin) {
    // Echo the literal origin header back (browsers compare the value, not
    // our normalized form). The match has already validated it's in our list.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    // Allow-Credentials is intentionally omitted: block iframes don't carry
    // civitai session cookies (cross-origin), and emitting "false" is a no-op
    // per the CORS spec. Setting "true" would require Allow-Origin to never
    // be "*", and we want that flexibility on the wrapped handler's path.
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return 'handled';
    }
    return 'fallthrough';
  }

  // Opaque-origin (`Origin: null`) opt-in — opted-in block endpoints only (see
  // WithBlockScopeOpts.allowOpaqueOrigin). Unverified blocks run sandboxed
  // without `allow-same-origin` → opaque origin → `Origin: null`, which can
  // never be in the allowlist above. We echo `ACAO: null` ONLY when the
  // endpoint opted in. Allow-Credentials stays omitted (no cookies ride a
  // null-origin request anyway), and the real GET still requires a valid block
  // JWT — the preflight is policy only, the token is the gate.
  if (opts.allowOpaqueOrigin && origin === 'null') {
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return 'handled';
    }
    return 'fallthrough';
  }

  if (origin && req.headers.authorization?.toLowerCase().startsWith('bearer ')) {
    // A block-bearing call from an origin we don't recognize is almost
    // always a missing OauthClient.allowedOrigins entry for the app (or a
    // 60s-stale cache window right after approve, see ORIGIN_CACHE_TTL_MS).
    // Browsers won't surface the failed preflight; log once per unique
    // origin so ops can see it.
    if (rememberWarnedOrigin(origin)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[block-scope] rejected CORS preflight from origin "${origin}" — not in OauthClient.allowedOrigins (cache may be stale up to 60s)`
      );
    }
  }

  return 'fallthrough';
}

function isBlockJwt(token: string): boolean {
  // Strict check: 3 non-empty base64url segments, and the decoded header
  // carries alg=RS256 + typ=JWT. Stops the middleware from trying to verify
  // an opaque API key that happens to contain two dots.
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return false;
  try {
    // base64url decode without depending on Buffer typings
    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const header = JSON.parse(headerJson) as { alg?: string; typ?: string };
    // L-VERIFY: require typ=JWT exactly. The signer (BlockTokenService.sign)
    // has set `typ:'JWT'` since the first App Blocks commit, so accepting
    // `typ:undefined` was an unnecessary fail-open that let a header omit the
    // type discriminator. A token without it is not one we mint.
    return header.alg === 'RS256' && header.typ === 'JWT';
  } catch {
    return false;
  }
}

// Per-token-type belt-and-suspenders age caps (replaces the old global
// `maxTokenAge: '15m'` on jwtVerify). `exp` (the real lifetime, enforced by
// jwtVerify) is the primary control; THIS is the redundant defence that catches
// a signer bug emitting a too-long `exp` — applied PER TYPE so a 4h dev token is
// allowed while every other token type stays capped at 15min. The 30s slack
// matches the prior `clockTolerance: '30s'`.
const MAX_TOKEN_AGE_DEFAULT_SECONDS = 15 * 60; // 15min — production/all non-dev tokens
// 4h — dev:live tokens (dev:true claim). Imported from the SIGNER
// (block-token.service.ts DEV_TOKEN_LIFETIME_SECONDS) so the verify cap can
// never silently desync from the lifetime the signer actually stamps.
const MAX_TOKEN_AGE_DEV_SECONDS = DEV_TOKEN_LIFETIME_SECONDS;
const MAX_TOKEN_AGE_CLOCK_TOLERANCE_SECONDS = 30;

export async function verifyBlockToken(token: string): Promise<BlockTokenClaims | null> {
  // L-VERIFY: require a kid and verify against exactly that one key. The
  // signer (BlockTokenService.sign) has stamped a `kid` (sha256 of the key
  // modulus) on every block token since the first App Blocks commit
  // (5bf6f05b6) — there was never a kid-less issuance era on this branch, and
  // tokens live only 15m + are re-minted each render — so a missing/unknown
  // kid is not a token we issued. The prior "no kid → try every configured
  // key" fall-open let an attacker probe all keys with one forged header;
  // pinning to the kid'd key removes that and is still rotation-safe (a new
  // key is loaded into the by-kid map before tokens signed with it appear,
  // and the old key stays in the map until its tokens expire).
  let keys: Iterable<unknown>;
  try {
    const header = decodeProtectedHeader(token);
    const kid = typeof header.kid === 'string' ? header.kid : null;
    if (!kid) return null;
    const byKid = getBlockTokenVerificationKeysByKid();
    const selected = byKid.get(kid);
    // Unknown kid → fail closed rather than fanning out to every key.
    if (!selected) return null;
    keys = [selected];
  } catch {
    return null;
  }
  const keyArr = Array.from(keys as Iterable<Parameters<typeof jwtVerify>[1]>);
  if (keyArr.length === 0) return null;

  for (const key of keyArr) {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: BLOCK_TOKEN_ISSUER,
        audience: BLOCK_TOKEN_AUDIENCE,
        algorithms: ['RS256'],
        // M-3: 30s skew tolerance. jose defaults to 0, which produces
        // sporadic 401s right at issuance time when verifier and signer
        // clocks drift even slightly (~1s is common in containerized envs).
        clockTolerance: '30s',
        // B6 (per-type, replaces the old global maxTokenAge: '15m'): the
        // belt-and-suspenders age cap is enforced BELOW, after the claims are
        // verified, so it can differ by token type (4h for dev:live tokens,
        // 15min for everything else). jwtVerify STILL enforces `exp` here — the
        // real lifetime — so removing maxTokenAge does NOT remove lifetime
        // enforcement; it only lifts the single global age ceiling that would
        // otherwise reject a legitimate 4h dev token. See MAX_TOKEN_AGE_* below.
      });
      const claims = payload as unknown as BlockTokenClaims;
      // B6: strict scalar-type assertions on every claim we trust. jose's
      // jwtVerify already checks iss/aud/alg/exp, but if a signer ever
      // emits a non-string jti / scalar exp as array, downstream code
      // (revocation, audit indexing) would silently mis-handle it.
      if (
        typeof claims.sub !== 'string' ||
        typeof claims.blockId !== 'string' ||
        typeof claims.appId !== 'string' ||
        typeof claims.appBlockId !== 'string' ||
        typeof claims.blockInstanceId !== 'string' ||
        !Array.isArray(claims.scopes) ||
        typeof claims.iat !== 'number' ||
        typeof claims.exp !== 'number' ||
        typeof claims.jti !== 'string' ||
        // aud is the canonical multi-value claim — jose normalizes it. We
        // reject array forms outright; the issuer always emits a single string.
        typeof claims.aud !== 'string'
      ) {
        return null;
      }
      // Audit-9 #1: validate sub shape here so a forged token with
      // sub: "user:abc" is rejected at verify-time. Otherwise the seam is
      // a future handler that does claims.sub.startsWith('user:') and
      // parseInts without going through parseSubjectUserId.
      if (!isValidSubject(claims.sub)) return null;
      // Maturity claim shape guard. The claim is optional (absent on legacy
      // tokens), but if present it MUST be a finite number — a forged token
      // carrying a non-numeric / NaN / Infinity maxBrowsingLevel is rejected
      // outright so the generation clamp never coerces a junk ceiling into an
      // unintended (wider) maturity. (Consumers ALSO fail closed on absence;
      // this is the upstream belt that keeps a malformed claim from ever
      // reaching them.) Same for the advisory `domain` string.
      if (
        claims.maxBrowsingLevel !== undefined &&
        (typeof claims.maxBrowsingLevel !== 'number' || !Number.isFinite(claims.maxBrowsingLevel))
      ) {
        return null;
      }
      if (claims.domain !== undefined && typeof claims.domain !== 'string') {
        return null;
      }
      // DEV-marker shape guard. The claim is optional (absent on every
      // non-dev token), but if PRESENT it MUST be a boolean — a forged/garbage
      // `dev` (string, number, object) is rejected outright so the max-age cap
      // below can trust it. A signature-valid `dev:true` is only producible by
      // our own signer (jwtVerify already checked the RS256 signature against
      // our keys above), so the flag is trustworthy at this point.
      if (claims.dev !== undefined && typeof claims.dev !== 'boolean') {
        return null;
      }
      // RUN-FOR-REAL marker shape guard. Optional (absent on every non-review
      // token); if PRESENT it MUST be a boolean — a forged/garbage value is
      // rejected outright so the runtime aggregate-cap selector can trust it. A
      // signature-valid `reviewRunForReal:true` is only producible by our own
      // signer (the RS256 signature was already verified above).
      if (claims.reviewRunForReal !== undefined && typeof claims.reviewRunForReal !== 'boolean') {
        return null;
      }
      // Per-token-type max-age belt (replaces the global maxTokenAge). `exp`
      // already enforced the real lifetime in jwtVerify; this re-checks the age
      // against the type-specific cap so a signer bug emitting a too-long `exp`
      // is still caught. FAIL-SAFE TO THE SHORTER CAP: only an explicit
      // `dev === true` (validated boolean above) gets the 4h cap; absent /
      // false / anything-else → the 15min cap.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const ageSeconds = nowSeconds - claims.iat;
      const ageCapSeconds =
        claims.dev === true ? MAX_TOKEN_AGE_DEV_SECONDS : MAX_TOKEN_AGE_DEFAULT_SECONDS;
      if (ageSeconds > ageCapSeconds + MAX_TOKEN_AGE_CLOCK_TOLERANCE_SECONDS) {
        return null;
      }
      return claims;
    } catch {
      // try the next key
    }
  }
  return null;
}

// ⚠️ `USER_SUB_RE` and `isValidSubject` MOVED to `~/server/services/block-token-subject`
// — a zero-import leaf shared with the MINT (`block-token.service`), the revocation
// writer and the approval guard, so the format has one spelling instead of one per
// consumer. Re-exported here because this module is where every existing caller imports
// it from. The regex's own rationale travels with it: capping the digit length keeps
// `user:<unbounded digits>` from sliding past Number.MAX_SAFE_INTEGER and producing a
// silent mis-match against ctx.modelId.
export { isValidSubject };

/**
 * Extracts the userId from a verified `sub` claim. Use AFTER isValidSubject.
 * Returns null for `anon`; returns the integer userId for `user:<n>`.
 * Throws ForbiddenError for malformed input — callers that already validated
 * via isValidSubject won't see throws in practice.
 */
export function parseSubjectUserId(sub: string): number | null {
  if (sub === ANON_SUBJECT) return null;
  if (!USER_SUB_RE.test(sub)) {
    throw forbidden('malformed sub claim');
  }
  return Number.parseInt(sub.slice('user:'.length), 10);
}

class ForbiddenError extends Error {
  readonly status = 403 as const;
}
function forbidden(message: string) {
  return new ForbiddenError(message);
}

/**
 * Reads a query string parameter, rejecting array forms outright. For
 * context-binding we never want to accept `?id=12345&id=99999` — the
 * binding check could pass on the first value while the wrapped handler
 * processes a different one. Throws ForbiddenError on array form.
 */
function readBoundQueryString(req: NextApiRequest, name: string): string | undefined {
  const v = req.query[name];
  if (Array.isArray(v)) throw forbidden(`multiple values for query param ${name} not allowed`);
  return v;
}

/**
 * Enforces context binding per scope type. Each scope can require
 * additional request-shape checks beyond having-the-scope:
 *   - models:read:self   → query.id ≡ claims.ctx.modelId (integer match)
 *   - buzz:read:self     → claims.sub != 'anon'
 *   - social:tip:self    → claims.sub != 'anon'
 *   - user:read:self     → claims.sub != 'anon'
 *   - ai:write:budgeted  → claims.buzzBudget > 0
 *   - posts:write:self   → claims.sub != 'anon'
 *
 * Throws ForbiddenError on mismatch.
 */
export function enforceContextBinding(claims: BlockTokenClaims, req: NextApiRequest): void {
  for (const scope of claims.scopes) {
    // Deny-by-default: tokens carrying scopes we don't know about are
    // rejected here. The manifest validator is the registration-time gate;
    // this is the runtime gate. Together they bound the trust surface even
    // if a future scope ships without all its plumbing.
    if (!isKnownBlockScope(scope)) {
      throw forbidden(`unknown scope: ${scope}`);
    }
    switch (scope) {
      case 'models:read:self': {
        const modelIdStr = readBoundQueryString(req, 'id') ?? readBoundQueryString(req, 'modelId');
        // M10: decimal-only parse. Number('0x3039') === 12345 — an attacker
        // could otherwise pass the binding with ?id=0x3039 against
        // ctx.modelId=12345. Also reject any non-digit form.
        const modelId =
          modelIdStr != null && /^[0-9]+$/.test(modelIdStr) ? Number.parseInt(modelIdStr, 10) : NaN;
        const ctxModelId = Number(claims.ctx?.modelId ?? NaN);
        // isInteger over isFinite: '1.5' would parse to 1.5 (finite) and then
        // fail the equality against an integer ctxModelId, so it would 403
        // either way — but rejecting non-integer up front is clearer.
        if (!Number.isInteger(modelId) || !Number.isInteger(ctxModelId) || modelId !== ctxModelId) {
          throw forbidden('models:read:self bound to different modelId');
        }
        break;
      }
      case 'buzz:read:self':
      case 'social:tip:self':
      case 'user:read:self': {
        // Every :self scope requires an authenticated subject — there's no
        // anonymous "self" to read/tip. user:read:self joined this set
        // when /api/v1/blocks/me switched off buzz:read:self (audit I3).
        if (claims.sub === ANON_SUBJECT) {
          throw forbidden(`${scope} requires authenticated subject`);
        }
        break;
      }
      case 'ai:write:budgeted': {
        if (typeof claims.buzzBudget !== 'number' || claims.buzzBudget <= 0) {
          throw forbidden('ai:write:budgeted requires positive buzzBudget claim');
        }
        break;
      }
      case 'apps:storage:read':
      case 'apps:storage:write': {
        // The W4 KV store is per-(app, instance, user). There is no anonymous
        // "self" storage, so a token carrying a storage scope must have an
        // authenticated subject. The (instance,user) tuple binding itself is
        // enforced in `resolveStorageContext` (apps.router.ts) where the
        // actual KV read/write happens; this case exists so adding these
        // scopes to BLOCK_SCOPE_TO_OAUTH_BIT does NOT silently reintroduce the
        // fail-open the comment below warns about (audit fix 3 / L-M6).
        if (claims.sub === ANON_SUBJECT) {
          throw forbidden(`${scope} requires authenticated subject`);
        }
        break;
      }
      case 'apps:storage:shared:read': {
        // SHARED (app-global) READS are allowed for anon — the shared list +
        // counts are public within the app (the real per-op authorization + the
        // min-trust gate live in `resolveSharedContext`, apps-shared.router). No
        // extra request-shape binding here; presence of the scope is the check.
        break;
      }
      case 'apps:storage:shared:write': {
        // SHARED WRITES (append / vote / withdraw / report) are NEVER anonymous —
        // they are attributed to the subject and pass the min-trust gate. Reject an
        // anon subject here so wiring this scope can't silently fail open (mirrors
        // the apps:storage:write case). The trust gate itself is enforced in
        // `resolveSharedContext`.
        if (claims.sub === ANON_SUBJECT) {
          throw forbidden(`${scope} requires authenticated subject`);
        }
        break;
      }
      case 'collections:read:self':
      case 'collections:read:private':
      case 'collections:write:self': {
        // All three collections scopes are :self — there is no anonymous "self"
        // whose own/private collections to read or whose account to
        // follow-on-behalf-of. Require an authenticated subject here (mirrors the
        // social:tip:self / apps:storage:* :self cases). The per-op authority lives
        // in the block collections endpoints: reads enforce collection
        // visibility/ownership (a private collection is 404 without ownership AND
        // the read:private scope) + the maturity clamp; the follow write is
        // self-bound to this subject. No request-shape binding is added here —
        // presence of the scope + a non-anon subject is the middleware check.
        if (claims.sub === ANON_SUBJECT) {
          throw forbidden(`${scope} requires authenticated subject`);
        }
        break;
      }
      case 'posts:write:self': {
        // A Post belongs to a USER — there is no anonymous profile to post to, so
        // an anon subject can never satisfy this scope. Presence of the scope +
        // a non-anon subject is the middleware check; the real authority is
        // `blocks.createPostFromApp` (approval + revocation + write-trust +
        // per-source ownership/provenance + the host-chrome consent confirm).
        //
        // 🔴 THIS CASE IS NOT OPTIONAL AND ITS ABSENCE IS NOT SCOPED TO POSTING.
        // The loop walks EVERY scope on the token, and the `default:` arm below
        // throws. A known scope with no case here therefore 403s every REST
        // request the token makes — a models read, a catalog read, anything — so
        // omitting it bricks the whole app and reads as a bug in an unrelated
        // endpoint. It must land in the same commit as the
        // BLOCK_SCOPE_TO_OAUTH_BIT entry.
        if (claims.sub === ANON_SUBJECT) {
          throw forbidden(`${scope} requires authenticated subject`);
        }
        break;
      }
      default:
        // Fail closed (L-M6). Reaching here means a scope passed the
        // `isKnownBlockScope` gate above (it's in BLOCK_SCOPE_TO_OAUTH_BIT)
        // but has no explicit binding case in this switch — i.e. someone
        // added a scope to the constant without wiring its runtime binding.
        // Rather than accept it with no contextual binding (the prior
        // implicit fall-through), reject it. Every scope currently in
        // BLOCK_SCOPE_TO_OAUTH_BIT has a case above, so this never fires for
        // a valid token today; it only catches a future under-wired scope.
        throw forbidden(`scope has no runtime binding: ${scope}`);
    }
  }
}

export function withBlockScope(handler: NextApiHandler, opts: WithBlockScopeOpts): NextApiHandler {
  return async (req, res) => {
    const cors = await setBlockCors(req, res, opts);
    if (cors === 'handled') return;

    const authHeader = req.headers.authorization ?? '';
    const bearer = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice('bearer '.length).trim()
      : '';

    // No block bearer present (or it's an opaque API key, not a 3-part JWS)
    // — hand off to the wrapped handler so it can run its own auth/CORS path.
    // This is what keeps pre-PR behavior (PublicEndpoint's ACAO:*,
    // AuthedEndpoint's allow-credentials path) intact for legacy callers.
    if (!bearer || !isBlockJwt(bearer)) {
      return handler(req, res);
    }

    // Decision 4: gate block-JWT verification on the dedicated GLOBAL runtime
    // flag (`app-blocks-runtime-enabled`) rather than the global eval of the
    // mod-segmented user flag (which could never resolve true without a user
    // context, leaving verification permanently dark even after deploys were
    // lit). Decoupled from the build pipeline flag so pausing builds doesn't
    // kill live runtime verification. Safe to be global because VERIFICATION
    // confers no authority — it only re-validates a token the independently-
    // gated mint endpoint already issued (mint, per-user-gated on
    // `app-blocks-enabled`, is the real authorization boundary). The token is
    // kid-pinned/RS256/iss-aud/max-age-checked + server-private-signed, so it
    // can't be forged or scope-inflated; there is no unauthorized path to ANY
    // verifiable token. So gating verification globally does not widen
    // visibility. (Do NOT rely on "mod-only minting" — mint has an anon-
    // conversion branch; the property is "verify grants nothing mint didn't.")
    //
    // Fail-safe / fall-through: when the runtime flag is off (or absent / Flipt
    // down → isFlipt false), the wrapper falls through to the legacy auth path
    // even if a block JWT is present. The caller sees the SAME response as if it
    // hadn't sent a block token (no 401, no block scope granted) — no info leak,
    // and identical to the prior dark behaviour on the user flag.
    if (!(await isAppBlocksRuntimeEnabled())) {
      return handler(req, res);
    }

    const claims = await verifyBlockToken(bearer);
    if (!claims) {
      res.status(401).json({ error: 'invalid block token' });
      return;
    }

    // Runtime observability (additive + dark — no behavior change): per-app REST
    // RED. Recorded on response finish so it captures the wrapped handler's real
    // status + latency AND the middleware's OWN 403 rejections below (revocation
    // / missing-scope / context-binding). The invalid-token 401 above is
    // intentionally NOT attributed — there are no claims, so no `app_block_id` to
    // key on. `endpoint`/`result` are strictly enumerated. Fire-and-forget: a
    // metrics failure must never poison the user-facing response.
    //
    // `app_block_id` cardinality: a normal (approved/pre-approval) token carries
    // a real FK appBlockId bounded to the approved-app set. A DEV token
    // (`claims.dev === true`, the same discriminator the max-age cap + audit path
    // use) carries EITHER a CALLER-CONSTRUCTED, synthetic, non-resolving appBlockId
    // (see dev-scoped-mint.service) OR — since #3285 — a real `apb_` id for an owner
    // dev-tunnelling their OWN suspended/pending/deprecated app; the synthetic case
    // makes this an unbounded label vector even though minting is mod/dev-cohort
    // gated. Bucket ALL dev tokens (real-id or synthetic) to the single stable
    // label 'dev' so that vector is closed while real per-app attribution is
    // preserved for non-dev tokens.
    const appBlockIdLabel = claims.dev === true ? 'dev' : claims.appBlockId;

    // ONE resolver for `opts.endpoint`, used by BOTH readers of it below (the RED
    // metric labels and the `not_found` log line). It was open-coded at the metric
    // site only, and the log line interpolated the union RAW — which stringifies the
    // FUNCTION on the one call site that passes a resolver (`blocks/tools.ts`), so
    // that log read `endpoint=(req) => (req.method === 'POST' ? …)` instead of naming
    // the endpoint. Consolidated rather than fixed twice: a second copy is how the
    // two readers came to disagree in the first place.
    //
    // Called per read, never memoised, because the resolver is a function OF THE
    // REQUEST and both readers must see the request actually being described.
    const resolveEndpointLabel = (): AppBlockEndpoint =>
      typeof opts.endpoint === 'function' ? opts.endpoint(req) : opts.endpoint;
    const metricStart = process.hrtime.bigint();
    let metricRecorded = false;
    const recordBlockMetric = () => {
      if (metricRecorded) return;
      metricRecorded = true;
      try {
        const { requestsTotal, requestDurationSeconds } = ensureRegisterAppBlockRuntimeMetrics();
        // Resolved HERE, inside the recorder, so a per-request resolver sees the
        // request that is actually being recorded. Both `finish` and `close`
        // run through the recorded-once guard above, so it resolves at most
        // once per request either way.
        const labels = { app_block_id: appBlockIdLabel, endpoint: resolveEndpointLabel() };
        const elapsedSeconds = Number(process.hrtime.bigint() - metricStart) / 1e9;
        requestDurationSeconds.observe(labels, elapsedSeconds);
        requestsTotal.inc({ ...labels, result: statusToRequestResult(res.statusCode) });
      } catch {
        // never let observability break the request
      }
    };
    // 'close' covers a client-aborted connection that never emits 'finish'; the
    // recorded-once guard makes the pair idempotent.
    res.on('finish', recordBlockMetric);
    res.on('close', recordBlockMetric);

    // H-2: per-instance revocation check. Uninstall, toggleEnabled(false) and a
    // publisher ban each write a marker that lives for one full token lifetime.
    // Tokens for revoked instances are rejected here before the wrapped handler
    // runs. Fail-open on Redis incidents.
    //
    // 🔴 THE BAN LEG IS NEW, AND OTHER FILES CITE THIS COMMENT AS THE AUTHORITY ON
    // IT — keep the enumeration here honest or they all go stale together.
    // History, because this line has been wrong in both directions: it once read
    // "and (Phase 2) publisher-ban all write a marker" while NO ban writer existed,
    // and was then corrected to say a ban writes none of the three. As of
    // clawgate #618 the writer exists, so the correction is itself now stale.
    // By enumeration, there are now TWO WRITERS over TWO KEYSPACES, and `isRevoked`
    // refuses if either holds a marker. The INSTALL writer `revokeInstance` has two
    // production call sites — `uninstallFromModel` and `toggleEnabled(false)`, both
    // `block-registry.service.ts`. The BAN writer `revokeInstanceForBan` has one,
    // `revokeBlockInstancesForPublisher` (`blocks/publisher-ban-revocation.service.ts`),
    // which `toggleBan` (`user.service.ts`) calls in its ban fan-out.
    //
    // 🔴 THE SPLIT IS THE CONTROL. With one shared key, `toggleEnabled(false)` — an
    // ordinary model owner, reachable over tRPC — overwrote a ban marker and
    // `toggleEnabled(true)` then cleared it, putting a banned publisher's live token back
    // into service. Separate keyspaces make that unrepresentable. Both ledgers are pinned
    // by `blocks/__tests__/publisher-ban-revocation.namespaces.test.ts`.
    //
    // 🔴 WHAT THE BAN LEG COVERS IS NARROWER THAN "a banned user's tokens stop
    // working". It marks every live instance of every block the banned user
    // CANONICALLY owns — `resolveCanonicalListingOwner`, which is `AppListing.userId`
    // for an offsite listing and NOT `app.userId`; deliberately not apps they merely
    // hold a collaborator seat on, which would take down another account's product. It
    // is asynchronous with respect to a request already in flight: a token minted
    // before the ban is refused on its NEXT call here, not mid-call. And it is
    // TIME-BOXED — the markers expire after one token lifetime; durability beyond that
    // is clawgate #620, layered on top of this rather than replacing it.
    //
    // 🔴 THE `page_` PREFIX IS FIVE MINT SHAPES, AND ONE OF THEM IS UNCOVERED:
    // `page_local_<slug>`, the dev mint's no-server-row path — nothing ties that slug to
    // a user, so there is nothing to enumerate at ban time and its 4h token runs to
    // natural `exp`. This line previously said "ONE SHAPE" while the writer said "THREE",
    // and both undercounted; the authoritative enumeration, with which shapes are
    // covered and why, lives on `revokeBlockInstancesForPublisher`. Do not restate a
    // count here — read it there.
    //
    // `block-approval.service.ts` still never consults owner ban state — the
    // approved-status gate below is a separate signal, and a ban does not flip
    // `app_blocks.status`.
    //
    // Do not re-add a fourth cause to this list without adding its writer.
    // `claims.sub` verbatim: the subject-scoped ban keyspace exists because
    // `page_ephemeral-<slug>` is NOT globally unique across users, so a global marker
    // there would refuse an innocent author's own tunnel. See `bannedSubjectKey`.
    if (await BlockRevocation.isRevoked(claims.blockInstanceId, claims.sub)) {
      // 🔴 THE ONLY SIGNAL THIS REFUSAL EMITS. `recordScopeInvocation` registers its
      // `res.on('finish')` handler further down, AFTER this early return, so a revocation
      // 403 has never been able to write a `block_scope_invocations` row — the audit
      // surface a reader would assume covers it. Without this counter, "revocation fired"
      // and "revocation is broken and silently serving" are the same observation.
      recordBlockRevocationRefusal('rest', claims.blockInstanceId);
      res.status(403).json({ error: 'block instance revoked' });
      return;
    }

    // APPROVED-STATUS GATE. The whole argument, the `dev` exemption, how it reconciles
    // with the two shared-storage resolvers' different rules, and the two postures live
    // on `resolveRestApprovalVerdict` in
    // `~/server/services/blocks/block-approval.service` — one docblock, not two.
    //
    // 🔴 WHICH VERDICTS REFUSE IS NOT UNIFORM ACROSS THE FOUR, AND FOR ONE OF THEM IT IS
    // NOT UNIFORM ACROSS ROUTES EITHER.
    //
    //   `not_approved`  — ALWAYS 403, on every route. This branch carries the whole of the
    //                     gate's value: every moderator takedown leaves a row whose status
    //                     is not `approved`. Nothing opts out of it.
    //   `lookup_failed` — 503 BY DEFAULT (fail closed: a read we could not complete tells
    //                     us nothing), but SERVED on routes that declare
    //                     `onApprovalLookupFailure: 'serve'`. See that option's docblock
    //                     for the argument; the short form is that this read is NEW, so
    //                     failing it closed introduces a fleet-wide availability coupling
    //                     rather than restoring a previous posture, and on a route where
    //                     refusing removes no exposure that trade is all cost.
    //   `not_found`     — ALWAYS SERVED. A signature-valid, non-dev token that resolves to
    //                     NO row is a HEALTHY app — a row deleted or re-keyed mid-session,
    //                     blockId drift, an id-minting bug — so refusing it would 404 a
    //                     live public endpoint in exchange for closing no takedown path.
    //   `tunnel_lookup_failed`
    //                   — ALWAYS 403, on every route, and 🔴 `onApprovalLookupFailure`
    //                     DOES NOT COVER IT. That option is scoped to `lookup_failed`
    //                     alone, deliberately: its argument is that a REPLICA read we
    //                     cannot complete should not take down routes where refusing
    //                     removes no exposure. This verdict is a CACHE read failing on the
    //                     dev-tunnel re-check, and the app it guards is already
    //                     NOT-approved — so serving it would not be tolerating an
    //                     unknown, it would be serving a known non-approved app because a
    //                     cache was down. If you are adding a route that wants
    //                     lookup-failure tolerance, this is the row that does not bend.
    //
    // All four are COUNTED regardless, before any of them branches. The counter is the
    // alerting signal and it must not depend on what the route then decided to do.
    //
    // 🔴 The revocation check above fails OPEN and `lookup_failed` here fails CLOSED. That
    // is not an inconsistency in this function: revocation's fail-open lives INSIDE the
    // primitive (`BlockRevocation.isRevoked` swallows a Redis error and returns false), so
    // a "cleanup" here could not align them even if it wanted to.
    //
    // ORDER MATTERS AND MIRRORS THE BRIDGE: revocation is a Redis GET and responds to a
    // USER action within seconds, so it runs first and a revoked-AND-suspended instance
    // is reported as revoked. This DB read runs second and only on instances that
    // survived it.
    const approval = await resolveRestApprovalVerdict(claims);
    if (approval !== 'ok' && approval !== 'dev_exempt') {
      recordBlockRestApprovalVerdict(approval);
      if (approval === 'not_approved' || approval === 'tunnel_lookup_failed') {
        // 🔴 BOTH REFUSE 403, WITH THE SAME BODY — the split is for the COUNTER, which
        // has already recorded the distinct `reason=` two lines above. A bearer learning
        // that the dev-tunnel cache is down rather than that the app is not approved
        // would be an infrastructure oracle with no benefit to it.
        //
        // ⚠️ NOT ROUTED THROUGH `lookup_failed`, which is the reuse that would look
        // tidier: that verdict answers 503 and is SERVED on the routes declaring
        // `onApprovalLookupFailure: 'serve'`. A non-approved app must not be served on
        // any route because a CACHE read failed, and a cache fault must not be reported
        // as a replica fault. Refusing here keeps both halves honest.
        res.status(403).json({ error: 'app block is not approved' });
        return;
      }
      if (approval === 'lookup_failed') {
        if (opts.onApprovalLookupFailure !== 'serve') {
          res.status(503).json({ error: 'app block status unavailable' });
          return;
        }
        // SERVED by this route's declared policy; execution falls through to the handler.
        //
        // 🔴 DELIBERATELY NOT LOGGED HERE. `resolveRestApprovalVerdict` has already logged
        // this failure, THROTTLED, with the underlying error message — and an unthrottled
        // second line at this call site would re-create exactly the problem that throttle
        // exists for: a replica incident fails every block REST request on every pod at
        // once, so a per-request line here is a log-volume event at full REST rate. The
        // `not_found` branch below DOES log per request because it is bounded by one app's
        // traffic rather than the whole fleet's, and because its ids are the only
        // attribution that branch has.
      } else {
        // `not_found` — OBSERVED, NOT REFUSED; execution falls through to the handler.
        // The ids go in the log rather than on the counter: this fires once per such
        // request with nothing rate-limiting it, and an `app_block_id` label would be
        // retained in the Node heap forever, per pod.
        //
        // 🔴 THIS LINE IS THE ENTIRE ATTRIBUTION MECHANISM for the one branch the gate
        // serves, so `endpoint` goes through `resolveEndpointLabel()` — interpolating
        // `opts.endpoint` raw stringifies the FUNCTION on a resolver call site and the
        // line then names no endpoint at all.
        approval satisfies 'not_found';
        // eslint-disable-next-line no-console
        console.warn(
          `[block-scope] approved-status lookup found no app_blocks row; SERVING (observe-only) appId=${
            claims.appId
          } blockId=${claims.blockId} endpoint=${resolveEndpointLabel()}`
        );
      }
    }

    // "Any valid block token" mode (opts.requiredScope omitted): the token has
    // already passed full validation + the revocation check above. Skip the
    // per-scope authorization check AND enforceContextBinding — these endpoints
    // (the public catalog) authorize on token-validity alone and derive their
    // only authority (the maturity ceiling) from claims.maxBrowsingLevel, not a
    // scope. See WithBlockScopeOpts.requiredScope.
    if (opts.requiredScope !== undefined) {
      if (!claims.scopes.includes(opts.requiredScope)) {
        res.status(403).json({ error: `missing required scope: ${opts.requiredScope}` });
        return;
      }

      try {
        enforceContextBinding(claims, req);
      } catch (err) {
        if (err instanceof ForbiddenError) {
          res.status(403).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    (req as BlockScopedNextApiRequest).blockClaims = claims;

    // Audit B3 + B4: when a block JWT is in use, the wrapped handler (which
    // may be PublicEndpoint/AuthedEndpoint) will run its own addCorsHeaders
    // + addPublicCacheHeaders. We want our exact-origin CORS to win and we
    // do NOT want the per-user response to be cached at the edge.
    //
    // Intercept the response's setHeader / removeHeader / writeHead for the
    // keys we own. Subsequent writes to those headers (from the wrapped
    // handler) are dropped; other headers (Content-Type, ETag, etc.) pass
    // through unchanged.
    //
    // Audit-9 #2: also wrap removeHeader (so a wrapped handler can't strip
    // our Cache-Control) and writeHead (which accepts a header bag in its
    // second arg and bypasses setHeader entirely). PublicEndpoint and
    // AuthedEndpoint use only setHeader today; the wrap-everything posture
    // protects against a future change.
    const ownedHeaders = new Set([
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-headers',
      'access-control-allow-methods',
      'vary',
      'cache-control',
    ]);
    const originalSetHeader = res.setHeader.bind(res);
    const originalRemoveHeader = res.removeHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);

    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (typeof name === 'string' && ownedHeaders.has(name.toLowerCase())) {
        return res;
      }
      return originalSetHeader(name, value);
    }) as typeof res.setHeader;

    res.removeHeader = ((name: string) => {
      if (typeof name === 'string' && ownedHeaders.has(name.toLowerCase())) {
        return;
      }
      return originalRemoveHeader(name);
    }) as typeof res.removeHeader;

    res.writeHead = ((statusCode: number, ...rest: unknown[]) => {
      // writeHead supports (status), (status, headers), or
      // (status, statusMessage, headers). Filter owned keys out of any
      // header bag we see; otherwise pass through verbatim.
      const filtered = rest.map((arg) => {
        if (!arg || typeof arg !== 'object' || Array.isArray(arg)) return arg;
        const obj = arg as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(obj)) {
          if (!ownedHeaders.has(k.toLowerCase())) out[k] = v;
        }
        return out;
      });
      return (originalWriteHead as (...args: unknown[]) => typeof res)(statusCode, ...filtered);
    }) as typeof res.writeHead;

    // Mark the response as uncacheable for block-JWT calls — even though
    // the v1 payloads happen to be public, the moment a wrapped route
    // differentiates by claims.sub (e.g., shows drafts to the owner), edge
    // caches would otherwise serve one user's view to another.
    originalSetHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');

    // W5 v0.5: log a BlockScopeInvocation row when the response finishes.
    // Fires after every successful scope+binding check (the wrapped handler
    // may still return 4xx/5xx — captured in statusCode). Only emit for
    // authenticated users — `sub='anon'` doesn't have a userId to attribute
    // to. Fire-and-forget; errors are swallowed so the audit pipeline can't
    // poison the user-facing response.
    const userIdForLog = parseSubjectUserId(claims.sub);
    if (userIdForLog != null) {
      const endpointForLog = normalizeEndpoint(req.url ?? '');
      res.on('finish', () => {
        // W13: a mutation handler may have stashed a structured action detail on
        // the response. Read it defensively (best-effort) — a missing/malformed
        // stash writes a plain, detail-less row (the passive-read path).
        const actionDetail = readBlockActionDetail(res);
        // Dynamic import so this module doesn't eager-load
        // user-app-surface.service (which transitively loads dbRead +
        // Prisma client init). Test envs that import the middleware for
        // pure routing checks shouldn't need a working DB.
        void import('~/server/services/blocks/user-app-surface.service')
          .then(({ recordScopeInvocation }) =>
            recordScopeInvocation({
              userId: userIdForLog,
              appBlockId: claims.appBlockId,
              blockInstanceId: claims.blockInstanceId,
              // In "any valid block token" mode there is no required scope; the
              // audit column is NOT NULL, so record a stable sentinel that
              // distinguishes these rows from real per-scope invocations.
              scope: opts.requiredScope ?? '(any-token)',
              endpoint: endpointForLog,
              statusCode: res.statusCode,
              ...(actionDetail ? { detail: actionDetail } : {}),
              // Phase 2: a dev token MAY carry a synthetic non-FK appBlockId (a
              // pre-approval dev-tunnel app) OR — since #3285 — a real `apb_` id
              // (an owner dev-tunnelling their own suspended/pending/deprecated
              // app). Passing `dev` lets the audit write persist a synthetic id via
              // the nullable-appBlockId path instead of FK-failing + swallowing; a
              // real id persists normally.
              dev: claims.dev === true,
            })
          )
          .catch(() => {
            // Audit log is best-effort. A failed write must not surface
            // to the client — the response already shipped. Errors are
            // logged by the service helper itself.
          });
      });
    }

    return handler(req, res);
  };
}

/**
 * Every STATIC path segment reachable through a `withBlockScope`-wrapped route,
 * and nothing else. This is the allowlist `normalizeEndpoint` templates against.
 *
 * It is a CLOSED set by construction: Next.js only dispatches a request to a
 * wrapped handler when the URL matches one of the wrapped route files verbatim
 * except for their `[id]` positions, so any segment not listed here arrived in a
 * dynamic position and is caller-supplied. (The count is deliberately not
 * written here — it was stale at "12" while the population was 13, and it moved
 * again when `blocks/buzz.ts` was restored. The drift test below is the
 * authority.) Kept in lockstep with those route files by
 * `block-scope.normalize-endpoint.test.ts`, which derives the set by walking
 * `src/pages/api` for every page extension Next accepts and matching both the
 * direct and indirect `withBlockScope(` wrap, rather than trusting this
 * comment.
 *
 * Not listed on purpose: `submissions`, `submit-version`, `withdraw`,
 * `dev-token`, `block-tokens`. Those routes live under `/api/v1/blocks` too but
 * authenticate with an API key, not a block JWT — they never call this
 * middleware, so listing them would be an unfalsifiable claim about a path this
 * function cannot see.
 */
export const KNOWN_STATIC_ENDPOINT_SEGMENTS = new Set([
  'api',
  'v1',
  'blocks',
  'buzz',
  'collections',
  'follow',
  'generation-resources',
  'images',
  'increment',
  'me',
  'models',
  'shared-storage',
  'tip',
  'tip-allowance',
  'tools',
  'top',
]);

/**
 * Reduce req.url to a route-shaped string for the audit log: strip the query
 * string + collapse every per-request path segment to a placeholder so the
 * cardinality of the `endpoint` column stays bounded.
 *
 * WHY THIS MATTERS: `endpoint` is the GROUP BY key of the `topEndpoints` rollup
 * (`app-analytics.service.ts` — `groupBy(['endpoint']) … take: 5`). An unbounded
 * value is not merely ugly, it fragments one logical route into N count-1 rows
 * and pushes the app's real traffic out of the top 5 entirely. #3561 fixed
 * exactly that for the five ROUTER call sites that interpolated an id into a
 * bounded literal; this function is the remaining writer to the same column.
 *
 * THE RULE IS ALLOWLIST-FIRST, NOT SHAPE-FIRST, and deliberately so. The static
 * vocabulary of these routes is itself slug-shaped — `generation-resources`,
 * `tip-allowance`, `shared-storage` — so NO shape heuristic can template
 * `my-collection-slug` without also templating those, and over-templating
 * destroys the aggregate just as thoroughly as under-templating (every route
 * collapses to one row). A segment in `KNOWN_STATIC_ENDPOINT_SEGMENTS` survives
 * verbatim and that arm wins over every shape test; everything else is a value
 * and is templated — `:id` / `:ulid` / `:uuid` where the shape is recognisable,
 * `:seg` otherwise.
 *
 * FIDELITY LIMITS — this is a heuristic. It deliberately does NOT cover:
 *   - Distinguishing a VALUE from a segment that collides with the static
 *     vocabulary. `/api/v1/blocks/collections/models` records as
 *     `/api/v1/blocks/collections/models`, not `…/:seg`. Bounded either way (the
 *     vocabulary is finite), and Next routes it to the `[id]` handler, which
 *     rejects it — so the row is a bounded 4xx, not a cardinality leak.
 *   - A NEW wrapped route whose static segments are not added to the set: it
 *     degrades to `:seg`. That is the safe direction (still bounded, just less
 *     readable) and the drift test fails until the set is updated.
 *   - The query string, which is DROPPED rather than templated — `?cursor=…`
 *     values never reach the column at all, so a cursor cannot fragment it.
 *   - Historical rows. No backfill is run, so the rollup mixes bounded and
 *     legacy unbounded values until the old rows age out of the query range.
 */
export function normalizeEndpoint(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      // A known static segment is never a caller-supplied value. This arm runs
      // FIRST so that a future static segment which happens to look like an id
      // (a `/v2` prefix, a `/2024` archive route) cannot be templated away.
      if (KNOWN_STATIC_ENDPOINT_SEGMENTS.has(seg)) return seg;
      // Numeric ids (modelId, collectionId, userId, etc.).
      if (/^\d+$/.test(seg)) return ':id';
      // ULIDs + their prefixed forms (apb_<26 ulid>, mbi_<26 ulid>, etc.).
      if (/^[A-Za-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return ':ulid';
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return ':ulid';
      // UUIDs (any version, either case), incl. the same prefixed form.
      if (
        /^(?:[A-Za-z]+_)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
          seg
        )
      )
        return ':uuid';
      // Anything else in a dynamic position: a slug, a hash, a filename, a
      // percent-encoded blob, fuzzer junk. Unbounded by definition.
      return ':seg';
    })
    .join('/');
}
