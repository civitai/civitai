import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { sysRedis, REDIS_SYS_KEYS } from '~/server/redis/client';
import { submitVersionSchema } from '~/server/schema/blocks/publish-request.schema';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * TOKEN-AUTHENTICATED bundle-submit route for the `civitai` CLI's `app submit`.
 *
 * This is a SECOND auth front-door to the SAME publish flow as the session/cookie
 * route at `src/pages/api/blocks/submit-version.ts`. The session route is
 * `ModEndpoint` (cookie + moderator) — usable from a logged-in browser but not
 * from a headless CLI, which has only an API key. This route accepts
 * `Authorization: Bearer <civitai API key>` instead, resolves the key → user via
 * the EXISTING API-key infrastructure (`getSessionFromBearerToken`, the same
 * helper that backs `/api/v1/*` REST auth and the retool bearer endpoint), then
 * applies the SAME gates the session route applies and calls the SAME
 * `submitVersion` service UNCHANGED. The publish logic is not forked.
 *
 * ## Gate posture
 *   - Auth: a valid civitai API key OR OAuth-issued token (both resolved by
 *     `getSessionFromBearerToken`, which hashes the credential with the same
 *     `generateSecretHash` the public REST API uses and looks it up in the
 *     `ApiKey` table — NO new key system).
 *   - Token type: a PERSONAL key always passes the type gate (unchanged). An
 *     OAuth-client-issued token passes ONLY if it carries the dedicated
 *     `TokenScope.AppBlocksSubmit` bit. That scope is opt-in, off-by-default, and
 *     EXCLUDED from `TokenScope.Full`, so only a client that explicitly lists it
 *     in `allowedScopes` and a user who explicitly consented can mint such a
 *     token (the first-party `civitai-cli` client is provisioned with it). An
 *     un-scoped OAuth token is rejected 403.
 *   - Feature flag: `isAppBlocksEnabled({ user })` evaluated WITH the resolved
 *     user's context (mirrors the session route + `enforceAppBlocksFlag`).
 *   - Moderator: the resolved user must be `isModerator` and not banned, on BOTH
 *     the personal-key and OAuth-token paths. App Blocks is mod-only pre-GA; this
 *     route keeps that posture (same as the session route's `ModEndpoint`). When
 *     App Blocks goes GA, RELAX this gate in lockstep with the session route —
 *     not unilaterally.
 *
 * ## Why no CSRF / Origin check here (unlike the session route)
 * The session route guards Origin because it is COOKIE-authed: a logged-in mod's
 * browser would attach their session cookie to a cross-site form POST (CSRF).
 * THIS route is BEARER-authed — the credential travels in an `Authorization`
 * header that a cross-site HTML form cannot set and the browser never attaches
 * automatically, so there is no ambient-authority/CSRF surface. The Origin guard
 * is therefore intentionally OMITTED (it would also break the headless CLI, which
 * sends no Origin).
 *
 * Body `{ bundleBase64: "<base64 zip>" }`, same ~72 MiB body ceiling +
 * MAX_BUNDLE_SIZE_BYTES schema cap as the session route. Returns
 * `{ publishRequestId, slug, version, status }`.
 */
export const config = {
  api: {
    bodyParser: {
      // Match the session route: a 50 MiB ZIP base64-encodes to ~67 MiB JSON.
      // The schema-level cap (MAX_BUNDLE_SIZE_BYTES) is enforced below and the
      // service re-checks the decoded buffer size.
      sizeLimit: '72mb',
    },
  },
};

// Bundle submit is heavy (decode + ZIP extract + deep manifest validation up to
// ~72 MiB). Keep the per-key window tight. The retool endpoint defaults to
// 60/min for cheap mod actions; a bundle upload warrants far less.
const RATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

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

  // 1. Auth — Bearer API key resolves to a Civitai user via the existing
  // API-key infrastructure (same helper as the public REST API / retool route).
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
  // token. `getSessionFromBearerToken` (src/server/auth/bearer-token.ts:42-58)
  // sets `subject = { type: 'oauth', id: clientId }` IFF the resolved `ApiKey`
  // row has a non-null `clientId` (minted for an OAuth client a user
  // authorized), and `{ type: 'apiKey', id }` for a user-type personal-access
  // key.
  //
  //  - PERSONAL key (`subject.type !== 'oauth'`, i.e. clientId == null): pass.
  //    This path is UNCHANGED from the launch-dark version — a logged-in mod's
  //    own key publishes as before. The downstream mod + flag gates still apply.
  //
  //  - OAUTH token (`subject.type === 'oauth'`): pass ONLY if the token carries
  //    the dedicated `TokenScope.AppBlocksSubmit` bit. `oauthClient.create` is an
  //    open `protectedProcedure` (any logged-in user can register a client), so
  //    we must NOT accept arbitrary OAuth tokens: a third-party app a mod
  //    authorizes for some unrelated scope would otherwise be able to publish App
  //    Blocks attributed to that mod (a consent escalation). `AppBlocksSubmit` is
  //    opt-in, off-by-default, and EXCLUDED from `TokenScope.Full` (see
  //    token-scope.constants.ts), so only a client that explicitly lists it in
  //    `allowedScopes` AND a user who explicitly consented to it can mint a token
  //    that reaches here. The first-party `civitai-cli` client is provisioned
  //    with exactly `UserRead | AppBlocksSubmit`.
  //
  // The moderator + not-banned gate (step 2) applies to BOTH paths — a scoped
  // OAuth token from a NON-moderator is still rejected there. Ordered after auth
  // (401) and before the mod gate so an un-scoped OAuth key gets 403, never a leak.
  if (session.subject?.type === 'oauth') {
    if (!Flags.hasFlag(session.tokenScope, TokenScope.AppBlocksSubmit)) {
      res.status(403).json({
        message:
          'App Blocks submit requires a personal API key or an OAuth token with the App Blocks submit scope',
      });
      return;
    }
  }

  // 2. Moderator gate — App Blocks is mod-only pre-GA (parity with the session
  // route's ModEndpoint). Resolve before touching the heavy body so a non-mod
  // key never costs a decode.
  if (!user.isModerator || user.bannedAt) {
    res.status(403).json({ message: 'App Blocks is restricted to the civitai team' });
    return;
  }

  // 3. Feature flag — evaluated WITH the authenticated user's context so the
  // `moderators`-segmented flag resolves ON for them (mirrors the session route
  // + enforceAppBlocksFlag). 503 when off.
  if (!(await isAppBlocksEnabled({ user }))) {
    res.status(503).json({ message: 'App Blocks is not enabled' });
    return;
  }

  // 4. Bundle storage must be configured (parity with the session route).
  const { env } = await import('~/env/server');
  if (!env.BUNDLE_S3_ENDPOINT || !env.BUNDLE_S3_BUCKET) {
    res.status(412).json({ message: 'Bundle storage not configured in this environment' });
    return;
  }

  // 5. Rate limit — per API key (the stable, authenticated identity), with a
  // client-IP fallback. `SET NX EX` + `INCR` in one MULTI (same atomic pattern
  // as the retool endpoint): the key is always created with its TTL, so a crash
  // between INCR and EXPIRE can't strand a TTL-less counter.
  // Per API key is the primary identity (always present for a resolved bearer
  // token); the client-IP form is a defensive fallback only.
  //
  // FOLLOW-UP (F2, not yet implemented): this bucket is per-API-KEY, but a user
  // can mint many personal keys (or rotate them) to widen their effective window.
  // The retool endpoint buckets on `actor.id` (per-user), which is the stronger
  // identity. Switching here to `user:${user.id}` would be the more robust limit;
  // left as a deliberate follow-up to keep this PR's auth change focused.
  const rateSubject = session.apiKeyId ? `key:${session.apiKeyId}` : `ip:${clientIp(req)}`;
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.SUBMIT_RATE_LIMIT}:${rateSubject}` as const;
  const multiResult = await sysRedis
    .multi()
    .set(rateKey, '0', { NX: true, EX: RATE_LIMIT.windowSeconds })
    .incr(rateKey)
    .exec();
  // F3 — fail CLOSED, not open, on a malformed limiter result. If `exec()`
  // returns null/short (Redis hiccup, MULTI aborted), `Number(undefined)` is
  // `NaN` and `NaN > max` is `false`, which would let the request slip through
  // un-limited. Treat a non-finite counter as "limiter unavailable" and reject
  // (503) rather than silently bypass — this is a heavy, mod-gated bundle upload,
  // so erring toward refusal is correct.
  const count = Number(multiResult?.[1]);
  if (!Number.isFinite(count)) {
    req.log?.warn('blocks/submit-version: rate-limit counter malformed; failing closed', {
      rateSubject,
    });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
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

  // 6. Validate the JSON body (same schema as the session route: bundleBase64
  // with the MAX_BUNDLE_SIZE_BYTES pre-decode cap).
  const parsed = submitVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid bundle payload' });
    return;
  }

  // 7. Decode the bundle bytes (cheap pre-decode cap already applied; the
  // service re-checks the real post-decode buffer size).
  let bundleBuffer: Buffer;
  try {
    bundleBuffer = Buffer.from(parsed.data.bundleBase64, 'base64');
  } catch (err) {
    res
      .status(400)
      .json({ message: `bundleBase64 is not valid base64: ${(err as Error).message}` });
    return;
  }

  // 8. Hand off to the SAME submitVersion service the session route uses — the
  // publish logic is not forked; this route is only a second auth front-door.
  try {
    const { submitVersion } = await import('~/server/services/blocks/publish-request.service');
    const result = await submitVersion({ bundleBuffer, submittedByUserId: user.id });
    // The service returns a richer object; the CLI contract is the stable subset.
    // `status` is always 'pending' for a fresh submission (mod review queue).
    res.status(200).json({
      publishRequestId: result.publishRequestId,
      slug: result.slug,
      version: result.version,
      status: 'pending',
    });
  } catch (err) {
    // The service throws plain Errors with human-readable messages (bundle too
    // large, missing manifest, invalid blockId/version/name, etc). Surface as
    // 400 so the CLI can print them — parity with the session route.
    res.status(400).json({ message: (err as Error).message });
  }
});
