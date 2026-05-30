import { decodeProtectedHeader, jwtVerify } from 'jose';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import {
  BLOCK_TOKEN_AUDIENCE,
  BLOCK_TOKEN_ISSUER,
  getBlockTokenVerificationKeys,
  getBlockTokenVerificationKeysByKid,
} from '~/server/services/block-token.service';
import { recordScopeInvocation } from '~/server/services/blocks/user-app-surface.service';
import { isKnownBlockScope } from '~/shared/constants/block-scope.constants';

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
  buzzBudget?: number;
}

export type BlockScopedNextApiRequest = NextApiRequest & {
  blockClaims?: BlockTokenClaims;
};

export interface WithBlockScopeOpts {
  requiredScope: string;
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

// Cached at module load — BLOCK_ALLOWED_ORIGINS is process-scoped env and
// shouldn't be re-split on every request.
let _allowedOriginsCache: string[] | null = null;
function getAllowedOrigins(): string[] {
  const cached = _allowedOriginsCache;
  if (cached != null) return cached;
  const raw = env.BLOCK_ALLOWED_ORIGINS ?? '';
  const next: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const norm = normalizeOrigin(trimmed);
    if (norm) next.push(norm);
  }
  _allowedOriginsCache = next;
  return next;
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  const norm = normalizeOrigin(origin);
  if (!norm) return false;
  return getAllowedOrigins().includes(norm);
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
 * Sets block-CORS headers when the origin is in BLOCK_ALLOWED_ORIGINS.
 *
 * Returns true ONLY when we've fully handled the request (block-origin preflight).
 * In every other case — including OPTIONS from origins we don't recognize —
 * returns false so the caller falls through to the wrapped handler's own
 * CORS path. This preserves the pre-PR behavior of routes like
 * /api/v1/models/[id] (which set ACAO: * in PublicEndpoint) for browser
 * integrations doing CORS preflight from origins outside BLOCK_ALLOWED_ORIGINS.
 */
function setBlockCors(req: NextApiRequest, res: NextApiResponse): 'handled' | 'fallthrough' {
  const origin = req.headers.origin;
  const isAllowed = originAllowed(origin);

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

  if (origin && req.headers.authorization?.toLowerCase().startsWith('bearer ')) {
    // A block-bearing call from an origin we don't recognize is almost always
    // a BLOCK_ALLOWED_ORIGINS misconfiguration. Browsers won't surface this
    // (the preflight just fails); log once per unique origin so ops can see it.
    if (rememberWarnedOrigin(origin)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[block-scope] rejected CORS preflight from origin "${origin}" — not in BLOCK_ALLOWED_ORIGINS`
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
    return header.alg === 'RS256' && (header.typ === 'JWT' || header.typ === undefined);
  } catch {
    return false;
  }
}

export async function verifyBlockToken(token: string): Promise<BlockTokenClaims | null> {
  // M-3: prefer kid-based selection. The header carries the signing key's
  // kid; we look up that one key and verify once. Falls back to trying all
  // configured keys if the kid is missing or doesn't match (e.g. a token
  // minted before kid was added; or during a rotation seam where the
  // header points at a key we haven't loaded yet).
  let keys: Iterable<unknown>;
  try {
    const header = decodeProtectedHeader(token);
    const kid = typeof header.kid === 'string' ? header.kid : null;
    if (kid) {
      const byKid = getBlockTokenVerificationKeysByKid();
      const selected = byKid.get(kid);
      keys = selected ? [selected] : getBlockTokenVerificationKeys();
    } else {
      keys = getBlockTokenVerificationKeys();
    }
  } catch {
    keys = getBlockTokenVerificationKeys();
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
        // B6: belt-and-suspenders cap. exp already enforces this since the
        // signer sets it to iat+900s, but maxTokenAge defends against a
        // future change that quietly extends the lifetime.
        maxTokenAge: '15m',
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
      return claims;
    } catch {
      // try the next key
    }
  }
  return null;
}

// M4: cap digit length to keep `user:<unbounded digits>` from sliding past
// Number.MAX_SAFE_INTEGER and producing a silent mis-match against ctx.modelId.
// 12 digits is well above any realistic civitai userId (~10 digits = 9.9B).
const USER_SUB_RE = /^user:[1-9][0-9]{0,11}$/;

/** True iff `sub` is one of the two valid shapes: `anon` or `user:<positive int>`. */
export function isValidSubject(sub: string): boolean {
  return sub === 'anon' || USER_SUB_RE.test(sub);
}

/**
 * Extracts the userId from a verified `sub` claim. Use AFTER isValidSubject.
 * Returns null for `anon`; returns the integer userId for `user:<n>`.
 * Throws ForbiddenError for malformed input — callers that already validated
 * via isValidSubject won't see throws in practice.
 */
export function parseSubjectUserId(sub: string): number | null {
  if (sub === 'anon') return null;
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
 *   - media:read:owned   → claims.sub != 'anon'
 *   - buzz:read:self     → claims.sub != 'anon'
 *   - social:tip:self    → claims.sub != 'anon'
 *   - user:read:self     → claims.sub != 'anon'
 *   - ai:write:budgeted  → claims.buzzBudget > 0
 *   - block:settings:*   → query.blockInstanceId ≡ claims.blockInstanceId
 *
 * Throws ForbiddenError on mismatch.
 */
export function enforceContextBinding(
  claims: BlockTokenClaims,
  req: NextApiRequest
): void {
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
        const modelIdStr =
          readBoundQueryString(req, 'id') ?? readBoundQueryString(req, 'modelId');
        // M10: decimal-only parse. Number('0x3039') === 12345 — an attacker
        // could otherwise pass the binding with ?id=0x3039 against
        // ctx.modelId=12345. Also reject any non-digit form.
        const modelId =
          modelIdStr != null && /^[0-9]+$/.test(modelIdStr)
            ? Number.parseInt(modelIdStr, 10)
            : NaN;
        const ctxModelId = Number(claims.ctx?.modelId ?? NaN);
        // isInteger over isFinite: '1.5' would parse to 1.5 (finite) and then
        // fail the equality against an integer ctxModelId, so it would 403
        // either way — but rejecting non-integer up front is clearer.
        if (
          !Number.isInteger(modelId) ||
          !Number.isInteger(ctxModelId) ||
          modelId !== ctxModelId
        ) {
          throw forbidden('models:read:self bound to different modelId');
        }
        break;
      }
      case 'media:read:owned':
      case 'buzz:read:self':
      case 'social:tip:self':
      case 'user:read:self': {
        // Every :self scope requires an authenticated subject — there's no
        // anonymous "self" to read/own/tip. user:read:self joined this set
        // when /api/v1/blocks/me switched off buzz:read:self (audit I3).
        if (claims.sub === 'anon') {
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
      case 'block:settings:read':
      case 'block:settings:write': {
        const requested = readBoundQueryString(req, 'blockInstanceId');
        if (!requested || requested !== claims.blockInstanceId) {
          throw forbidden(`${scope} bound to different blockInstanceId`);
        }
        break;
      }
      // No `default` — the unknown-scope reject above is the exhaustive
      // gate. Adding a new known scope to BLOCK_SCOPE_TO_OAUTH_BIT without
      // a case here means it is accepted with no extra binding.
    }
  }
}

export function withBlockScope(
  handler: NextApiHandler,
  opts: WithBlockScopeOpts
): NextApiHandler {
  return async (req, res) => {
    const cors = setBlockCors(req, res);
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

    // H-2: when App Blocks is dark, the wrapper falls through to the legacy
    // auth path even if a block JWT is present. Callers see the same
    // response as if they hadn't sent a block token — no information leak.
    if (!(await isAppBlocksEnabled())) {
      return handler(req, res);
    }

    const claims = await verifyBlockToken(bearer);
    if (!claims) {
      res.status(401).json({ error: 'invalid block token' });
      return;
    }

    // H-2: per-instance revocation check. Uninstall, toggleEnabled(false),
    // and (Phase 2) publisher-ban all write a marker that lives for one
    // full token lifetime. Tokens for revoked instances are rejected here
    // before the wrapped handler runs. Fail-open on Redis incidents.
    if (await BlockRevocation.isRevoked(claims.blockInstanceId)) {
      res.status(403).json({ error: 'block instance revoked' });
      return;
    }

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
    originalSetHeader(
      'Cache-Control',
      'private, no-store, no-cache, must-revalidate, max-age=0'
    );

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
        void recordScopeInvocation({
          userId: userIdForLog,
          appBlockId: claims.appBlockId,
          blockInstanceId: claims.blockInstanceId,
          scope: opts.requiredScope,
          endpoint: endpointForLog,
          statusCode: res.statusCode,
        }).catch(() => {
          // Audit log is best-effort. A failed write must not surface to the
          // client — the response already shipped. Errors are logged by the
          // service helper itself.
        });
      });
    }

    return handler(req, res);
  };
}

/**
 * Reduce req.url to a route-shaped string for the audit log: strip query
 * string + collapse path segments that look like ids/ulids to a placeholder
 * so the cardinality of the `endpoint` column stays bounded.
 */
function normalizeEndpoint(rawUrl: string): string {
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  return path
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      // Numeric ids (modelId, userId, etc.).
      if (/^\d+$/.test(seg)) return ':id';
      // ULIDs + their prefixed forms (apb_<26 ulid>, mbi_<26 ulid>, etc.).
      if (/^[A-Za-z]+_[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return ':ulid';
      if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(seg)) return ':ulid';
      return seg;
    })
    .join('/');
}
