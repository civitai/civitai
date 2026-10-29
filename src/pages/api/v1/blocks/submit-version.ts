import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import {
  submitVersionParseErrorMessage,
  submitVersionSchema,
} from '~/server/schema/blocks/publish-request.schema';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { SUBMIT_RATE_LIMIT, takeSubmitSlot } from '~/server/services/blocks/submit-rate-limit';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * TOKEN-AUTHENTICATED bundle-submit route for the `civitai` CLI's `app submit`.
 *
 * This is a SECOND auth front-door to the SAME publish flow as the session
 * route at `src/pages/api/blocks/submit-version.ts`. The session route takes a
 * signed-in session or a full-access personal key (`requireFullScopeSession`),
 * the same author capability as this route, and a prod Origin check — usable
 * from a logged-in browser (App Assistant's Submit for review) but not from a
 * headless CLI, which sends no Origin and may hold a scoped OAuth token. This route accepts
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
 *   - Author: the resolved user must not be banned and must hold the authoring
 *     capability (`isAppBlocksAuthorEnabled`: the `app-blocks-author` Flipt cohort,
 *     with moderators always in), on BOTH the personal-key and OAuth-token paths.
 *     The session route applies the same capability to a signed-in session or a
 *     full-access personal key.
 *
 * ## Why no CSRF / Origin check here (unlike the session route)
 * The session route guards Origin because it takes the session COOKIE: a logged-in
 * author's browser would attach it to a cross-site form POST (CSRF).
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
  // token. `getSessionFromBearerToken` (src/server/auth/bearer-token.ts)
  // sets `subject = { type: 'oauth', id: clientId }` IFF the resolved `ApiKey`
  // row has a non-null `clientId` (minted for an OAuth client a user
  // authorized), and `{ type: 'apiKey', id }` for a user-type personal-access
  // key.
  //
  //  - PERSONAL key (`subject.type !== 'oauth'`, i.e. clientId == null): pass.
  //    The downstream author + flag gates still apply.
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
          'Submitting an App requires a personal API key or an OAuth token with the Apps submit scope',
      });
      return;
    }
  }

  // 2. Author gate — App Blocks authoring is capability-gated on the dedicated
  // `app-blocks-author` flag (static fallback mod-only), so a curated non-mod
  // cohort can submit. A BANNED account is always rejected regardless of the
  // capability. Resolve before touching the heavy body so a non-author key never
  // costs a decode. (This is AUTHZ; the `isAppBlocksEnabled` kill-switch below
  // is a separate gate.)
  if (user.bannedAt) {
    res.status(403).json({ message: 'Apps are restricted to the Civitai team' });
    return;
  }
  if (!(await isAppBlocksAuthorEnabled({ user }))) {
    res.status(403).json({ message: 'Apps are restricted to the Civitai team' });
    return;
  }

  // 3. Feature flag — evaluated WITH the authenticated user's context so the
  // `moderators`-segmented flag resolves ON for them (mirrors the session route
  // + enforceAppBlocksFlag). 503 when off.
  if (!(await isAppBlocksEnabled({ user }))) {
    res.status(503).json({ message: 'Apps are not enabled' });
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
  // F3 + #28: the limiter fails CLOSED (a Redis throw, a hang past the sys read deadline, or a
  // malformed counter is a 503, never a silent bypass). See `takeSubmitSlot`.
  const slot = await takeSubmitSlot(rateSubject);
  if (!slot.ok && slot.reason !== 'limited') {
    req.log?.warn(
      slot.reason === 'unavailable'
        ? 'blocks/submit-version: rate limiter threw; failing closed'
        : 'blocks/submit-version: rate-limit counter malformed; failing closed',
      { rateSubject }
    );
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  if (!slot.ok) {
    const retryAfter = slot.retryAfterSeconds;
    res.setHeader('Retry-After', String(Math.max(retryAfter, 1)));
    res.status(429).json({
      message: 'Rate limit exceeded',
      retryAfterSeconds: retryAfter,
      limit: SUBMIT_RATE_LIMIT.max,
      windowSeconds: SUBMIT_RATE_LIMIT.windowSeconds,
    });
    return;
  }

  // 6. Validate the JSON body (same schema as the session route: bundleBase64
  // with the MAX_BUNDLE_SIZE_BYTES pre-decode cap).
  const parsed = submitVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    // Names the offending field when the failure is confined to the #4059
    // provenance fields; still exactly 'Invalid bundle payload' for a bundle
    // problem. This is the route the CLI actually posts to, so an unnamed
    // rejection here is the one that costs an author a debugging session.
    res.status(400).json({ message: submitVersionParseErrorMessage(parsed.error) });
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
    const result = await submitVersion({
      bundleBuffer,
      submittedByUserId: user.id,
      submitterIsModerator: !!user.isModerator,
      // #4059 — pass the client's provenance CLAIM through untouched. Absent
      // stays absent; the service must not invent a value.
      sourceCommit: parsed.data.sourceCommit,
      sourceDirty: parsed.data.sourceDirty,
    });
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
