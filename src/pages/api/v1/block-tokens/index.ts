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
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { getAllServerHosts } from '~/server/utils/server-domain';
import {
  isKnownBlockScope,
  validateBlockScopesAgainstOauthClient,
} from '~/shared/constants/block-scope.constants';

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
// browsing context. We require modelId + slotId here because resolveBlockInstance
// uses them as the auth pin for synthetic blockInstanceIds (`pdb_*`, `bus_*`)
// — those rows don't carry modelId themselves and the resolver re-validates
// the claim against the source predicates before mint. The resolver returns
// the *validated* modelId/slotId from the source row (not the client's), and
// only those validated values reach the JWT ctx.
const slotContextSchema = z
  .object({
    modelId: z.coerce.number().int().positive(),
    slotId: z.string().min(1).max(64),
  })
  .passthrough();

const requestSchema = z.object({
  blockInstanceId: z.string().min(1).max(64),
  slotContext: slotContextSchema,
});

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
  const candidate = typeof raw === 'number' && Number.isFinite(raw) ? raw : BUZZ_BUDGET_DEFAULT;
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

  // H-2: server-side feature-flag gate. The substrate ships dark; the UI
  // mount + workflow callback aren't the only entry points an attacker
  // could probe. 503 (Service Unavailable) is the right code: the surface
  // exists but is intentionally off.
  if (!(await isAppBlocksEnabled())) {
    res.status(503).json({ error: 'App Blocks not enabled' });
    return;
  }

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

  // Phase 2 (internal-only graduation gate): App Blocks is moderator-only
  // until GA. Block tokens are the linchpin — the entire block-token runtime
  // (workflow submit/poll/cancel/estimate, KV storage, /blocks/me) is reachable
  // only with a minted token, so gating MINTING on isModerator makes the whole
  // surface transitively mod-only. Anon callers (no session) get no token.
  // The per-call assertViewerIsModerator checks in blocks/apps routers are the
  // defense-in-depth layer on top of this. Reject right after the session load
  // (before the per-(subject,instance) rate-limit + resolveBlockInstance DB
  // read) so a non-mod can't probe install existence or consume those buckets.
  if (!session?.user?.isModerator) {
    res.status(403).json({ error: 'App Blocks is restricted to the civitai team' });
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

  // Use dbWrite (primary) so a freshly-suspended block can't be installed
  // through a replication-lag window. resolveBlockInstance handles all four
  // blockInstanceId namespaces (real install `bki_*`, platform default `pdb_*`,
  // publisher subscription `bus_pub_*`, viewer subscription `bus_view_*`) and
  // re-validates the caller's (modelId, slotId) claim against the source row
  // — for synthetic ids that's the only cross-check, since the row itself
  // isn't per-model.
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
  const block = install.appBlock;
  if (!block || block.status !== 'approved') {
    res.status(403).json({ error: 'Block is not approved' });
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
  const manifestScopes = rawManifestScopes.filter(isKnownBlockScope);

  // Audit-9 #4: pre-reject anon callers requesting `:self` scopes here at
  // issuance, instead of letting them mint a token that enforceContextBinding
  // 403s on first use. The runtime path was returning a fatal_block_error
  // fallback for what is really a misconfigured-block-for-anon-viewer case.
  const ANON_REJECTED_SCOPES = new Set([
    'user:read:self',
    'buzz:read:self',
    'media:read:owned',
    'social:tip:self',
  ]);
  if (userId == null) {
    const needsAuth = manifestScopes.filter((s) => ANON_REJECTED_SCOPES.has(s));
    if (needsAuth.length > 0) {
      res.status(403).json({
        error: 'manifest requires authenticated viewer; this block cannot render for anon',
        scopes: needsAuth,
      });
      return;
    }
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
  // from slotContext. modelId and slotId come from the install row. The
  // client's slotId, if any, is dropped.
  const ctx: Record<string, unknown> = {
    ...projectClientCtx(slotContext),
    modelId: install.modelId,
    slotId: install.slotId,
  };

  const result = await BlockTokenService.sign({
    userId,
    blockId: block.blockId,
    appId: block.appId,
    appBlockId: block.id,
    blockInstanceId,
    scopes: manifestScopes,
    ctx,
    buzzBudget,
  });

  res.status(200).json({ token: result.token, expiresAt: result.expiresAt });
});
