import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { env } from '~/env/server';
import { withAxiom } from '@civitai/next-axiom';
import { dbWrite } from '~/server/db/client';

// H2 (audit-10): cap the request body BEFORE Next's default 1MB parse runs.
// slotContext is z.record(z.string(), z.unknown()) so a determined attacker
// under the 120/min per-IP limit could still push ~120MB/min of parse
// pressure through legitimate IPs. 8KB is comfortably above any realistic
// slotContext (the projection allowlist clamps fields anyway).
export const config = {
  api: {
    bodyParser: { sizeLimit: '8kb' },
  },
};
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { BlockTokenService } from '~/server/services/block-token.service';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import {
  getAllServerHosts,
  getRequestDomainColor,
  isHostForColor,
  isMatureContentRating,
} from '~/server/utils/server-domain';
import {
  allBrowsingLevelsFlag,
  domainBrowsingCeiling,
} from '~/shared/constants/browsingLevel.constants';
import {
  isKnownBlockScope,
  validateBlockScopesAgainstOauthClient,
} from '~/shared/constants/block-scope.constants';
import { isLaunchSlot, isPageSlot, PAGE_FORBIDDEN_SCOPES } from '~/shared/constants/slot-registry';
import {
  getGrantedScopes,
  partitionByConsent,
  consentGatedScopes,
} from '~/server/services/blocks/scope-grant.service';

/**
 * POST /api/v1/block-tokens
 *
 * Issues an RS256-signed block-scoped JWT for a single block instance.
 * Token lifetime: 15 minutes. Rate limits: 120/min per IP, 60/min per (subject, instance).
 *
 * Anon viewers receive a token with `sub: "anon"`. Scopes requiring an
 * authenticated subject (buzz:read:self, social:tip:self, media:read:owned)
 * are rejected downstream by the block-scope middleware.
 *
 * CSRF posture: SAME-ORIGIN ONLY with EXACT host equality. The host page on
 * civitai.com fetches the token here and passes it into the iframe via
 * BLOCK_INIT — the iframe at blocks.civitai.com never calls this endpoint
 * directly. We deliberately do NOT use the shared addCorsHeaders helper
 * because that matcher uses `origin.startsWith(allowedOrigin)` which would
 * accept `https://civitai.com.attacker.tld` against the allowlist entry
 * `https://civitai.com`. We use exact normalized-origin equality here.
 *
 * If a future Phase wants iframes to self-refresh tokens, this gate widens
 * and brings its own CSRF mitigation (Origin+Referer check, double-submit
 * cookie, or per-block CSRF token).
 */

// slotContext is sent by the iframe host (useBlockToken.ts) and carries the
// browsing context. It is now ENTITY-AWARE (W10): an optional `entityType`
// discriminator selects the binding shape. The default (omitted entityType) is
// the historical MODEL contract — modelId required — so existing model
// producers (ModelVersionDetails) are byte-identical. A `none` (page) request
// carries no modelId.
//
// MODEL: requires modelId + slotId. resolveBlockInstance uses them as the auth
// pin for synthetic blockInstanceIds (`pdb_*`, `bus_*`) — those rows don't
// carry modelId themselves and the resolver re-validates the claim against the
// source predicates before mint. The resolver returns the *validated*
// modelId/slotId from the source row (not the client's), and only those
// validated values reach the JWT ctx.
//
// NONE (page): viewer-scoped, no entity. slotId is the page slot; no modelId.
const modelSlotContextSchema = z
  .object({
    entityType: z.literal('model').optional(),
    modelId: z.coerce.number().int().positive(),
    slotId: z.string().min(1).max(64),
  })
  .passthrough();

const pageSlotContextSchema = z
  .object({
    entityType: z.literal('none'),
    slotId: z.string().min(1).max(64),
  })
  .passthrough();

const slotContextSchema = z.union([pageSlotContextSchema, modelSlotContextSchema]);

const requestSchema = z.object({
  blockInstanceId: z.string().min(1).max(64),
  slotContext: slotContextSchema,
});

// W10 — synthetic block-instance id prefix for a stateless full-page app. The
// id is `page_<appBlockId>`; there is no install row (Decision 2).
const PAGE_INSTANCE_PREFIX = 'page_';

const BUZZ_BUDGET_DEFAULT = 10;
const BUZZ_BUDGET_CAP = 1000;

const PER_IP_RATE_LIMIT_WINDOW_SECONDS = 60;
const PER_IP_RATE_LIMIT_MAX = 120;

function projectClientCtx(slotContext: Record<string, unknown>): Record<string, unknown> {
  // What goes in the JWT ctx claim is ONLY what a downstream scope might
  // bind against (e.g. modelId for models:read:self). Everything else —
  // modelVersionId, modelName, modelType, modelNsfwLevel, viewer fields,
  // theme — flows to the iframe through the BLOCK_INIT payload's
  // `context` field, which is NOT trust-bearing.
  //
  // M7 (audit-10): modelVersionId was previously projected into JWT ctx
  // even though no scope binds to it. JWT ctx is for binding; the BLOCK_INIT
  // payload is for display/state. They're different channels and shouldn't
  // be conflated. ModelSlotContext-as-a-whole reaches the iframe via
  // BLOCK_INIT (see IframeHost.buildInitPayload), so blocks still see
  // modelVersionId; it just doesn't get baked into trust-bearing claims.
  //
  // NB: modelId and slotId are validated by resolveBlockInstance against
  // the source row and stamped into ctx by the handler AFTER this call —
  // never read them from slotContext here.
  void slotContext; // intentionally unused — see comment
  return {};
}

/**
 * Returns the set of normalized origins that may call this endpoint. Same
 * set as addCorsHeaders' `allowedOrigins`, but pre-normalized (lowercase
 * scheme+host, no trailing slash) so the equality check is robust.
 */
function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

let _sameOriginAllowedCache: Set<string> | null = null;
function getSameOriginAllowed(): Set<string> {
  const cached = _sameOriginAllowedCache;
  if (cached) return cached;
  const set = new Set<string>();
  const candidates: Array<string | undefined> = [
    env.NEXTAUTH_URL,
    ...(env.TRPC_ORIGINS ?? []),
    ...getAllServerHosts(),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const withScheme = c.startsWith('http') ? c : `https://${c}`;
    const norm = normalizeOrigin(withScheme);
    if (norm) set.add(norm);
  }
  _sameOriginAllowedCache = set;
  return set;
}

/**
 * H1 fix: exact host equality. The shared addCorsHeaders uses startsWith,
 * which would accept `https://civitai.com.attacker.tld` for the allowlist
 * entry `https://civitai.com`. CORS still blocks read because ACAO is set
 * to the allowlist entry (not the request origin) — but the server still
 * processes the request, which is a foothold the moment any side effect
 * lands on token issuance.
 */
function setSameOriginCors(req: NextApiRequest, res: NextApiResponse): 'handled' | 'continue' {
  const origin = req.headers.origin;
  const norm = origin ? normalizeOrigin(origin) : null;
  const isAllowedOrigin = !!(norm && getSameOriginAllowed().has(norm) && origin);

  if (isAllowedOrigin && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return 'handled';
  }

  // B1: outright reject cross-origin POSTs. Pre-fix, an attacker could send
  // a Content-Type:text/plain POST without a preflight, the server would
  // process the request (mint + discard a token), and the victim's per-
  // (subject, instance) rate-limit bucket would be consumed. Modern browsers
  // always send Origin on POST. A missing-Origin POST is either a non-browser
  // tool (curl, server-to-server) or a same-page non-CORS request — both
  // cases legitimately POSTing the token endpoint should be rare and we
  // accept the breakage in exchange for closing the DoS path.
  if (req.method === 'POST' && !isAllowedOrigin) {
    res.status(403).json({ error: 'cross-origin POST rejected' });
    return 'handled';
  }
  return 'continue';
}

/**
 * Returns the IP used for per-IP rate limiting. cf-connecting-ip is trusted
 * ONLY when cf-ray is also present (Cloudflare always emits cf-ray on every
 * proxied request and direct-to-origin attackers can't set it because the
 * value identifies a specific CF datacenter request).
 *
 * Audit M-4: when cf-ray is absent we do NOT fall back to XFF / X-Real-IP —
 * those headers are attacker-controlled the moment the origin is reachable
 * without CF transit. The trade is that direct-to-origin debug traffic gets
 * bucketed under the LB / socket peer IP, which is the right fail-closed.
 */
function getClientIp(req: NextApiRequest): string {
  const cfRay = req.headers['cf-ray'];
  if (typeof cfRay === 'string' && cfRay.length > 0) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length > 0) return cf;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

// M-2 (audit): in-process LRU fallback for the per-IP rate limit when Redis
// is unreachable. Fully fail-open on a credentials-minting endpoint is the
// wrong default — an extended Redis outage would otherwise leave token
// issuance unbounded. Process-local enforcement is weaker than Redis (each
// pod has its own bucket) but stops the single-IP flood case.
//
// Cap at 1024 entries (insertion-order LRU drop) so a flood of unique IPs
// can't grow the Map unbounded.
const PROCESS_RL_MAX_ENTRIES = 1024;
const processRlBuckets = new Map<string, { count: number; resetAt: number }>();

function processFallbackRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = PER_IP_RATE_LIMIT_WINDOW_SECONDS * 1000;
  const existing = processRlBuckets.get(ip);
  if (!existing || existing.resetAt <= now) {
    if (processRlBuckets.size >= PROCESS_RL_MAX_ENTRIES) {
      const oldest = processRlBuckets.keys().next().value;
      if (oldest != null) processRlBuckets.delete(oldest);
    }
    processRlBuckets.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  existing.count += 1;
  return existing.count <= PER_IP_RATE_LIMIT_MAX;
}

async function checkPerIpRateLimit(ip: string): Promise<boolean> {
  const key = `${REDIS_KEYS.BLOCKS.TOKEN_RATE_LIMIT}:ip:${ip}` as const;
  try {
    const count = await redis.incrBy(key as never, 1);
    if (count === 1) {
      await redis.expire(key as never, PER_IP_RATE_LIMIT_WINDOW_SECONDS);
    } else {
      const ttl = await redis.ttl(key as never);
      if (ttl < 0) await redis.expire(key as never, PER_IP_RATE_LIMIT_WINDOW_SECONDS);
    }
    return count <= PER_IP_RATE_LIMIT_MAX;
  } catch {
    // M-2: fall back to in-process LRU instead of full fail-open on a
    // credential-minting endpoint.
    return processFallbackRateLimit(ip);
  }
}

function resolveBuzzBudget(
  scopes: string[],
  publisherSettings: Record<string, unknown>
): number | null {
  if (!scopes.includes('ai:write:budgeted')) return null;
  const raw = publisherSettings?.buzz_budget_per_gen;
  // Defense-in-depth (audit should-fix): require an INTEGER, not merely a
  // finite number. A fractional / Infinity / NaN / non-number value falls back
  // to the platform default rather than flowing through to a fractional Buzz
  // budget. This treats model slots and pages identically — both arrive here as
  // `buzz_budget_per_gen` (the model path from install settings, the page path
  // mapped from manifest `page.buzzBudgetPerGen`) and both clamp+gate the same
  // way. A valid positive integer (the model-slot common case) is unchanged.
  const candidate = typeof raw === 'number' && Number.isInteger(raw) ? raw : BUZZ_BUDGET_DEFAULT;
  if (candidate <= 0) return 0; // sentinel — caller rejects with 422
  return Math.min(candidate, BUZZ_BUDGET_CAP);
}

export default withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const cors = setSameOriginCors(req, res);
  if (cors === 'handled') return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!env.BLOCK_TOKEN_PRIVATE_KEY || !env.BLOCK_TOKEN_PUBLIC_KEY) {
    res.status(503).json({ error: 'Block tokens not configured' });
    return;
  }

  // H-2 / H2: the App Blocks feature-flag gate for this route is the PER-USER
  // `getFeatureFlags({ user }).appBlocks` check below (after the session load).
  // The previous GLOBAL pre-check here (`isAppBlocksEnabled()` with no user)
  // could never match the live `moderators`-segmented flag, so it 503'd EVERY
  // caller — including moderators — before the per-user gate ran (the H2
  // divergence). Removing it lets the per-user gate be authoritative: a mod
  // passes, a non-mod / anon caller is still refused (403) before any DB read.
  // The cheap per-IP rate limit below still runs first to throttle probing.

  const parsed = requestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
    return;
  }
  const { blockInstanceId, slotContext } = parsed.data;

  // H3 order: per-IP rate limit FIRST (before any DB read). The per-(subject,
  // instance) limit runs after the session lookup but BEFORE findUnique.
  const clientIp = getClientIp(req);
  const ipOk = await checkPerIpRateLimit(clientIp);
  if (!ipOk) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id ?? null;

  // Graduation gate: who may mint a block token is governed by the `appBlocks`
  // feature flag, evaluated for THIS caller (possibly anon). Today the flag is
  // `availability: ['mod']`, so this is behaviour-identical to the previous
  // hardcoded `isModerator` check — anon/non-mod callers fail the flag and are
  // refused. When the flag is later widened (preview/GA → `['user']`/`['public']`
  // via Flipt or the registry), anon/non-mod callers start passing here and the
  // anon-scope stripping below keeps the issued token safe (no money/self scope).
  //
  // Block tokens are the linchpin — the entire block-token runtime (workflow
  // submit/poll/cancel/estimate, KV storage, /blocks/me) is reachable only with
  // a minted token. The per-call assertViewerIsModerator checks in blocks/apps
  // routers remain the defense-in-depth layer on top of this. Evaluate right
  // after the session load (before the per-(subject,instance) rate-limit +
  // resolveBlockInstance DB read) so a refused caller can't probe install
  // existence or consume those buckets.
  const appBlocksAvailable = getFeatureFlags({ user: session?.user, req }).appBlocks;
  if (!appBlocksAvailable) {
    res.status(403).json({ error: 'Apps are not available to this account' });
    return;
  }

  // M1: gate banned and deleted users at issuance. Muted users can still
  // hold read-tokens (they can still see the page) but downstream interaction
  // routes enforce their own mute gates. Deleted accounts are rejected — a
  // valid session that survived a soft-delete shouldn't mint new tokens.
  if (session?.user) {
    const u = session.user;
    if (u.bannedAt) {
      res.status(403).json({ error: 'banned' });
      return;
    }
    // SessionUser may or may not carry deletedAt depending on the auth path;
    // we re-read it from dbWrite below if needed. Keep this guard cheap.
  }

  // H3: per-(subject, instance) rate limit BEFORE findUnique. The IP gate
  // already ran; this catches credentialed brute-force from many IPs.
  // For anon callers the bucket also includes clientIp so an unauthenticated
  // attacker can't fresh-mint a bucket by rotating blockInstanceId strings.
  const instanceOk = await BlockTokenService.checkRateLimit(userId, blockInstanceId, clientIp);
  if (!instanceOk) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  // Entity dispatch (W10). `entityType` is the discriminator: a `none` request
  // is a STATELESS full-page app (entity=none), everything else is the
  // historical MODEL path. The two paths resolve the approved AppBlock
  // differently but converge on the same scope-intersection + sign logic below.
  const entityType: 'model' | 'none' = slotContext.entityType === 'none' ? 'none' : 'model';

  // The resolved install shape both paths feed into the scope/sign logic.
  // For a page there is no install row, so modelId is null and installedBy is
  // null (no per-content owner); settings are empty.
  type ResolvedForMint = {
    appBlock: NonNullable<Awaited<ReturnType<typeof BlockRegistry.resolveBlockInstance>>>['appBlock'];
    modelId: number | null;
    slotId: string;
    installedByUserId: number | null;
    settings: Record<string, unknown>;
  };
  let resolved: ResolvedForMint | null = null;

  // Discriminate on slotContext.entityType (the zod union discriminator) so TS
  // narrows `slotContext` to the model variant (with `modelId`) in the else.
  if (slotContext.entityType === 'none') {
    // PAGE PATH (W10) — stateless, viewer-scoped, NO money scopes.
    //
    // Gate 1: the dedicated `appBlocksPages` flag must be available to this
    // caller (in addition to the master `appBlocks` gate above). So the page
    // surface enables independently and stays dark until its own flag is lit.
    const pagesAvailable = getFeatureFlags({ user: session?.user, req }).appBlocksPages;
    if (!pagesAvailable) {
      res.status(403).json({ error: 'App pages are not available to this account' });
      return;
    }
    // Gate 2: the slot must be a registered PAGE slot (defense in depth — a
    // page request carrying a model slotId is rejected, not silently coerced).
    if (!isPageSlot(slotContext.slotId)) {
      res.status(400).json({ error: 'entityType=none requires a page slot' });
      return;
    }
    // Gate 3: the instance id MUST be the synthetic `page_<appBlockId>` form.
    // The page surface has no other id namespace; reject anything else so a
    // model/synthetic id can't be smuggled into the page path.
    if (!blockInstanceId.startsWith(PAGE_INSTANCE_PREFIX)) {
      res.status(400).json({ error: 'page tokens require a page_<appBlockId> instance id' });
      return;
    }
    const appBlockId = blockInstanceId.slice(PAGE_INSTANCE_PREFIX.length);
    const page = await BlockRegistry.resolvePageBlock(appBlockId, { db: 'write' });
    if (!page) {
      // Missing / not-approved / not-a-page app → 404 (never leaks which).
      res.status(404).json({ error: 'Page app not found' });
      return;
    }
    // W10 generation spend: a page is stateless (no install settings row), so
    // its per-gen Buzz budget is sourced from the APPROVED manifest's
    // `page.buzzBudgetPerGen` field rather than from install settings. We map it
    // onto the same `buzz_budget_per_gen` settings key the model path uses, so
    // the existing resolveBuzzBudget(install.settings) calls below treat pages
    // and model slots IDENTICALLY — the same arbiter, the same clamp, the same
    // 422 on a non-positive value:
    //   - manifest declares a finite number   → pass it through verbatim;
    //     resolveBuzzBudget clamps >CAP to CAP and turns <=0 into the 0 sentinel
    //     → 422 INVALID_BUZZ_BUDGET (fail-closed, never a silent 0-budget token).
    //   - manifest omits it / non-number      → settings stay EMPTY so
    //     resolveBuzzBudget falls back to BUZZ_BUDGET_DEFAULT.
    // Passing a number through unconditionally (not pre-filtering to >0) keeps
    // a non-positive manifest budget a HARD ERROR rather than a silent default,
    // matching the model-slot contract.
    const pageManifest = (page.appBlock.manifest ?? {}) as { page?: { buzzBudgetPerGen?: unknown } };
    const manifestBudget = pageManifest.page?.buzzBudgetPerGen;
    const pageSettings: Record<string, unknown> =
      typeof manifestBudget === 'number' && Number.isFinite(manifestBudget)
        ? { buzz_budget_per_gen: manifestBudget }
        : {};
    resolved = {
      appBlock: page.appBlock,
      modelId: null,
      slotId: slotContext.slotId,
      installedByUserId: null,
      settings: pageSettings,
    };
  } else {
    // MODEL PATH (unchanged). Use dbWrite (primary) so a freshly-suspended
    // block can't be installed through a replication-lag window.
    // resolveBlockInstance handles all four blockInstanceId namespaces (real
    // install `bki_*`, platform default `pdb_*`, publisher subscription
    // `bus_pub_*`, viewer subscription `bus_view_*`) and re-validates the
    // caller's (modelId, slotId) claim against the source row — for synthetic
    // ids that's the only cross-check, since the row itself isn't per-model.
    const install = await BlockRegistry.resolveBlockInstance({
      blockInstanceId,
      modelId: slotContext.modelId,
      slotId: slotContext.slotId,
      viewerUserId: userId,
      db: 'write',
    });
    if (!install) {
      res.status(404).json({ error: 'Block install not found' });
      return;
    }
    resolved = {
      appBlock: install.appBlock,
      modelId: install.modelId,
      slotId: install.slotId,
      installedByUserId: install.installedByUserId,
      settings: install.settings,
    };
  }

  const install = resolved;
  const block = install.appBlock;
  if (!block || block.status !== 'approved') {
    res.status(403).json({ error: 'Block is not approved' });
    return;
  }

  // PAGE-ONLY LAUNCH GATE (belt at the mint — defense-in-depth over the install
  // path). The public (non-moderator) audience may only mint a token for a
  // LAUNCH slot (page apps). A non-mod model-slot install shouldn't exist after
  // the install-path gate, but the mint refuses one anyway. Moderators are
  // grandfathered so the live mod-only generate-from-model model-slot token
  // keeps minting. Mod status is the server-stamped session flag (same source
  // the per-call assertViewerIsModerator belts use), so it can't be spoofed.
  // `isLaunchSlot` is the single source of truth; the page path naturally
  // passes (app.page IS a launch slot) and is unchanged.
  const isModerator = session?.user?.isModerator === true;
  if (!isModerator && !isLaunchSlot(install.slotId)) {
    res.status(403).json({ error: 'This app type isn’t available yet.' });
    return;
  }

  // M1 (continued): if the session is authenticated, confirm the user row
  // isn't soft-deleted. SessionUser may not carry deletedAt; the row read
  // here is cheap and authoritative.
  if (userId != null) {
    const userRow = await dbWrite.user.findUnique({
      where: { id: userId },
      select: { deletedAt: true, bannedAt: true },
    });
    if (!userRow || userRow.deletedAt || userRow.bannedAt) {
      res.status(403).json({ error: 'account unavailable' });
      return;
    }
  }

  const rawManifestScopes =
    Array.isArray((block.manifest as { scopes?: unknown }).scopes)
      ? ((block.manifest as { scopes: string[] }).scopes.filter(
          (s) => typeof s === 'string'
        ) as string[])
      : [];

  const oauthAllowed = block.app?.allowedScopes ?? 0;
  const scopeCheck = validateBlockScopesAgainstOauthClient(rawManifestScopes, oauthAllowed);
  if (!scopeCheck.valid) {
    res.status(403).json({
      error: 'block manifest carries scopes outside the OAuth client allowlist',
      rejected: scopeCheck.rejectedScopes,
    });
    return;
  }

  // H-2: intersect requested scopes with the approved-scope snapshot. An
  // approved manifest re-published with added scopes already loses approval
  // (status → 'pending', filtered above), but the approved_scopes column is
  // the authoritative pinning. Empty array = fail-closed.
  const approvedScopes = new Set(block.approvedScopes ?? []);
  if (approvedScopes.size === 0) {
    res.status(403).json({ error: 'block has no approved scopes' });
    return;
  }
  const outsideApproved = rawManifestScopes.filter((s) => !approvedScopes.has(s));
  if (outsideApproved.length > 0) {
    res.status(403).json({
      error: 'block manifest carries scopes outside the approved snapshot',
      rejected: outsideApproved,
    });
    return;
  }
  const requestedScopes = rawManifestScopes.filter(isKnownBlockScope);

  // W10 PAGE HARD RULE (belt over the manifest + approved-scope intersection):
  // a page (kind==='page', entity=none) is viewer-scoped with no model entity
  // and no per-content install — money/spend scopes have nothing to bind or
  // attribute against, so they are UNCONDITIONALLY rejected here. Even if an
  // app's approved manifest declared `ai:write:budgeted` / `buzz:read:self` /
  // `social:tip:self`, a page mint refuses to issue. This is the deterministic
  // server-side gate, independent of the SDK/manifest declaration.
  if (entityType === 'none' && isPageSlot(install.slotId)) {
    const forbidden = new Set<string>(PAGE_FORBIDDEN_SCOPES);
    const offending = requestedScopes.filter((s) => forbidden.has(s));
    if (offending.length > 0) {
      res.status(403).json({
        error: 'page apps cannot carry money/spend scopes',
        rejected: offending,
      });
      return;
    }
  }

  // A6 (audit HIGH / design-gaps C2): intersect the scopes about to be signed
  // with the viewer's per-user grant for this (user, app_block). Any scope the
  // app's approved manifest requests but the user has NOT granted is WITHHELD
  // from the minted token and reported back to the host as `needs_consent` so
  // it can surface a re-consent prompt. This is the per-user layer beneath the
  // manifest/approved ceiling: a v2 that adds a scope no longer silently mints
  // that scope for an existing install — the user must re-consent first.
  //
  // The per-user grant gate only applies to authenticated callers. Anon callers
  // (allowed through the mint gate once the appBlocks flag is public) are handled
  // by the anon-scope strip immediately below — they have no grant ledger. The
  // grant lookup is keyed on (userId, appBlockId); a missing grant row → empty
  // set → every consent-gated scope is withheld (fail-closed). Publisher/ambient
  // scopes (block:settings:*, apps:storage:*) are consent-exempt and always pass
  // through — see partitionByConsent.
  let manifestScopes = requestedScopes;
  let needsConsent = false;
  let missingScopes: string[] = [];
  if (userId != null) {
    const granted = await getGrantedScopes({ userId, appBlockId: block.id, db: 'write' });
    const { signable, missing } = partitionByConsent(requestedScopes, granted);
    manifestScopes = signable;
    missingScopes = missing;
    needsConsent = missing.length > 0;
  }

  // Anonymous conversion: a logged-out viewer gets a token carrying ONLY the
  // anon-safe scope subset rather than a 403. The anon-safe subset is the
  // manifest scopes with every consent-gated scope STRIPPED — which is exactly
  // every `:self` / owned / money / tip scope (`user:read:self`,
  // `buzz:read:self`, `media:read:owned`, `social:tip:self`,
  // `ai:write:budgeted`, `models:read:self`, …). `consentGatedScopes` is the
  // single source of truth for "requires a per-user grant"; an anon viewer has
  // no grant and never can, so the entire consent-gated set is withheld.
  //
  // What remains for anon is only the consent-exempt scopes
  // (`apps:storage:*`; `block:settings:*` is additionally installer-only and
  // gets rejected just below for anon). For generate-from-model the manifest is
  // `models:read:self` + `ai:write:budgeted`, so the anon subset is empty — the
  // block renders from the (scope-free) BLOCK_INIT context (showcase + form),
  // and Generate stays server-gated: with no `ai:write:budgeted` scope the
  // submitWorkflow path rejects, which the block converts into a sign-in prompt.
  //
  // SECURITY INVARIANT: no money/self/owned/tip scope can appear in an anon
  // token. Because the strip set is the COMPLEMENT of the consent-exempt set
  // (not an allowlist of "known bad" scopes), any future money/self-class scope
  // added to the vocabulary is stripped for anon by default (fail-closed),
  // unless it is explicitly added to CONSENT_EXEMPT_SCOPES.
  if (userId == null) {
    const stripped = consentGatedScopes(manifestScopes);
    manifestScopes = manifestScopes.filter((s) => !stripped.includes(s));
    // No consent signal for anon — the host converts an attempted gated action
    // into a sign-in prompt, not a re-consent flow.
    missingScopes = [];
    needsConsent = false;
  }

  // C8: settings scopes are publisher-only. Caller must be the install's
  // installedByUserId. When the publisher's account has been deleted,
  // installedByUserId is NULL (SET NULL FK) → this check fails for everyone,
  // which is the correct fail-closed behavior — the model owner can uninstall.
  const wantsSettingsScope = manifestScopes.some(
    (s) => s === 'block:settings:read' || s === 'block:settings:write'
  );
  if (wantsSettingsScope) {
    if (userId == null || userId !== install.installedByUserId) {
      res.status(403).json({
        error: 'block:settings:* tokens require the block installer',
      });
      return;
    }
  }

  if (manifestScopes.includes('ai:write:budgeted')) {
    const budget = resolveBuzzBudget(
      manifestScopes,
      (install.settings ?? {}) as Record<string, unknown>
    );
    if (budget === null || budget <= 0) {
      res.status(422).json({ error: 'INVALID_BUZZ_BUDGET' });
      return;
    }
  }

  const buzzBudget = manifestScopes.includes('ai:write:budgeted')
    ? resolveBuzzBudget(manifestScopes, (install.settings ?? {}) as Record<string, unknown>) ??
      undefined
    : undefined;

  // M3 + M4: ctx is fully server-stamped except for the projected scalars
  // from slotContext. The client's slotId, if any, is dropped.
  //
  // ENTITY-AWARE ctx (W10):
  //  - MODEL path: ctx is `{ modelId, slotId }` — BYTE-IDENTICAL to pre-W10.
  //    No `entityType` field is added, so `enforceContextBinding` (reads
  //    ctx.modelId), `getEffectiveCheckpoint`, and `updateUserSettings` see
  //    exactly the claims they saw before. The model entity is implicit in the
  //    presence of `modelId`. (Regression-locked: the model token's claims for
  //    `generate-from-model` must be byte-identical.)
  //  - PAGE path (entity=none): ctx is `{ slotId, entityType: 'none' }` — NO
  //    modelId. A page token therefore can NEVER satisfy a model-bound check
  //    (`models:read:self` needs ctx.modelId, which is absent → 403) and the
  //    page-forbidden money scopes were already rejected at mint.
  const ctx: Record<string, unknown> =
    entityType === 'none'
      ? {
          ...projectClientCtx(slotContext),
          slotId: install.slotId,
          entityType: 'none',
        }
      : {
          ...projectClientCtx(slotContext),
          modelId: install.modelId,
          slotId: install.slotId,
        };

  // MATURITY ENFORCEMENT (GA gate). Stamp the AUTHORITATIVE color-domain
  // maturity ceiling into the token AT MINT, derived from the request host
  // (the same host the CORS allowlist above already trusts). This claim is the
  // generation/catalog maturity boundary for the token's whole 15-min lifetime:
  // a token minted on green/blue carries the SFW ceiling, red carries the
  // mature ceiling. The block submit/estimate path derives `allowMatureContent`
  // from THIS claim (never a client body field), so a SFW-domain block cannot
  // generate mature output even if its own code is wrong or malicious.
  //
  // NSFW-APP-RED-ONLY: `domainBrowsingCeiling(getRequestDomainColor(req))` would
  // return the SFW ceiling on civitai.red, because `getRequestDomainColor`
  // first-matches blue for .red (it is configured as BOTH blue and red). For the
  // block path we want the host's RED capability to drive the ceiling: a
  // red-capable host (`isHostForColor(host, 'red')` — TRUE for civitai.red and
  // its aliases) mints the FULL mature ceiling; every other host keeps the
  // domain-color SFW derivation. Scoped to the block path only — the global
  // color resolution / domainBrowsingCeiling semantics are untouched.
  //
  // Fail-closed: an unknown/missing host or a non-red host → the SFW ceiling. We
  // always emit the claim so consumers can distinguish a legacy (pre-feature)
  // token — which has NO claim and is treated as SFW by the consumer — from an
  // explicit red mint.
  const host = req.headers.host ?? '';
  const redCapableHost = host !== '' && isHostForColor(host, 'red');
  const domainColor = getRequestDomainColor(req);
  const maxBrowsingLevel = redCapableHost
    ? allBrowsingLevelsFlag
    : domainBrowsingCeiling(domainColor);

  // DEFENSE-IN-DEPTH cross-check (fail-closed, refuse): a mature-rated app
  // (contentRating ∈ {r, x}, the authoritative manifest field the validator
  // requires + approve stores) may NEVER mint a token on a non-red-capable host.
  // The run-page SSR gate + the listing filter already hide/404 mature apps off
  // .red, so a mint request for one on .com should not happen through the UI —
  // but a direct API caller could try, so we refuse here rather than down-clamp
  // (a clamp would still hand back a usable token; refusal is unambiguous and
  // leaves the run-page 404 as the only surface). The dev-token path is a
  // SEPARATE endpoint (forced-SFW) and is unaffected.
  const appContentRating = (block.manifest as { contentRating?: unknown }).contentRating;
  if (typeof appContentRating === 'string' && isMatureContentRating(appContentRating) && !redCapableHost) {
    res.status(403).json({ error: 'This app is only available on civitai.red.' });
    return;
  }

  const result = await BlockTokenService.sign({
    userId,
    blockId: block.blockId,
    appId: block.appId,
    appBlockId: block.id,
    blockInstanceId,
    scopes: manifestScopes,
    ctx,
    buzzBudget,
    domain: domainColor ?? null,
    maxBrowsingLevel,
  });

  // A6: surface the consent signal alongside the token. The token carries only
  // the granted subset; `needsConsent` + `missingScopes` tell the host to prompt
  // the user to re-consent for the scopes the app's approved manifest declares
  // but the user hasn't granted. The host renders the block with the granted
  // scopes meanwhile (a block requesting only ungranted scopes still gets a
  // valid token — it just can't use the withheld capabilities until consent).
  res.status(200).json({
    token: result.token,
    expiresAt: result.expiresAt,
    needsConsent,
    missingScopes,
    // Advisory maturity signal for the host → BLOCK_INIT. The AUTHORITATIVE
    // enforcement is the same claim baked into the token above; this is the
    // plaintext mirror so the host doesn't JWT-decode and blocks can
    // self-filter their catalog reads / blur. See projectBlockInit.ts.
    domain: domainColor ?? null,
    maxBrowsingLevel,
  });
});
