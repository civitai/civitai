import type { Logger } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from '~/types/session';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { sysRedis, REDIS_SYS_KEYS, withSysReadDeadline } from '~/server/redis/client';
import {
  submitVersionParseErrorMessage,
  submitVersionSchema,
} from '~/server/schema/blocks/publish-request.schema';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
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
 * Body `{ bundleBase64: "<base64 zip>" }`. ⚠ The transport ceiling here is
 * MAX_REQUEST_BODY_BYTES (~10 MiB, about a 7.5 MiB ZIP once base64-encoded) — NOT the
 * session route's ~72 MiB, because this path is proxy-matched and Next truncates it.
 * An oversize submit gets a 413 naming the actual size (civitai/cli #423); see
 * `readJsonBody`. MAX_BUNDLE_SIZE_BYTES still caps the DECODED bundle. Returns
 * `{ publishRequestId, slug, version, status }`.
 */
export const config = {
  api: {
    // 🔴 The body is read and parsed BY THIS ROUTE — see `readJsonBody`. That is not a
    // style choice; it is the only way this endpoint can answer a size problem with a
    // size error.
    //
    // This path is covered by `src/proxy.ts`'s `matcher`, and Next truncates a
    // proxy-matched body at `experimental.proxyClientMaxBodySize` (default 10485760)
    // and then ENDS THE STREAM without saying so. With `bodyParser` enabled the
    // truncated remains are handed to `parseBody`, which fails on half a JSON document
    // and answers `400 Invalid JSON` — an error about the parse, downstream of the real
    // cause. That is civitai/cli #423: the CLI had to start reporting what it SENT
    // because the response carried nothing usable.
    //
    // 🔴 AND NO `sizeLimit` VALUE FIXES IT — measured, not reasoned. `parseBody` 413s
    // only when the bytes it RECEIVES exceed the declared limit, and the proxy truncates
    // at a CHUNK BOUNDARY, so what arrives is a ragged size strictly BELOW the cap
    // (12,000,000 in gave 10,438,916 / 10,479,830 / 10,483,999 across three runs). Every
    // one is under any limit that would not also reject legitimate traffic. A previous
    // attempt to declare one byte below the cap shipped and was refuted by execution:
    // `civitai#4793`, closed unmerged, carries the full matrix.
    //
    // What is NOT truncated is the `Content-Length` HEADER. It still states the size the
    // client actually sent, which is why the check in `readJsonBody` can refuse before
    // reading a byte and name the real number. Same mechanism as
    // `src/pages/api/v1/image-upload/relay.ts`, which is the only other route here that
    // needs a size refusal to work.
    bodyParser: false,
  },
};

/**
 * Largest body this route will accept, and the point Next truncates at.
 *
 * Not a product limit — `MAX_BUNDLE_SIZE_BYTES` (50 MiB) still bounds the DECODED
 * bundle and the service re-checks it. This is the transport ceiling, and it is set by
 * the framework rather than chosen: above it the request cannot arrive intact, so
 * accepting it would mean storing or rejecting a body we never fully received.
 *
 * ⚠ A ~7.5 MiB ZIP once base64 expansion (4/3) and the JSON envelope are counted. The
 * product promises 50 MiB, so this endpoint is NARROWER than the session route at
 * `src/pages/api/blocks/submit-version.ts`, which is not proxy-matched and really does
 * receive 72mb. Closing that gap means raising `experimental.proxyClientMaxBodySize` in
 * next.config.mjs AND this constant, in the SAME change — raising either alone leaves
 * the limit where it is.
 */
export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// Bundle submit is heavy (decode + ZIP extract + deep manifest validation up to
// MAX_REQUEST_BODY_BYTES). Keep the per-key window tight. The retool endpoint defaults to
// 60/min for cheap mod actions; a bundle upload warrants far less.
const RATE_LIMIT = { max: 10, windowSeconds: 60 } as const;

/**
 * Read the request body and parse it as JSON, refusing an oversize one with a SIZE error.
 *
 * Returns `undefined` when it has already answered on the wire — every caller must
 * `return` on that, or it would send a second response.
 *
 * 🔴 The `Content-Length` pre-check is the whole point and it runs BEFORE a byte is read.
 * The proxy truncates the BODY but not the HEADER, so on the request that motivated this
 * (civitai/cli #423) the header still says what the client sent and we can name that
 * number back. Reading first and measuring afterwards cannot work: the bytes are already
 * gone, and what is left looks like a complete-but-malformed document.
 *
 * The running-total check below is NOT redundant with it — a chunked request sends no
 * `Content-Length` at all, and a client may understate one. Neither can overrun the cap.
 *
 * The truncation check is the third case and it is the subtle one: a body that ARRIVES
 * shorter than its own declared length was cut in transit, which is exactly what the
 * proxy does. Parsing that would either fail confusingly or — worse, if the cut happened
 * to land on a valid boundary — succeed on a partial bundle.
 */
export async function readJsonBody(
  req: NextApiRequest,
  res: NextApiResponse
): Promise<unknown | undefined> {
  const declaredRaw = req.headers['content-length'];
  const declared = Number(Array.isArray(declaredRaw) ? declaredRaw[0] : declaredRaw);
  const hasDeclared = Number.isInteger(declared) && declared >= 0;

  const tooLarge = (actual: number) => {
    res.status(413).json({
      message:
        `Bundle payload is ${actual} bytes; this endpoint accepts at most ` +
        `${MAX_REQUEST_BODY_BYTES}. Reduce the bundle (roughly ${Math.floor(
          (MAX_REQUEST_BODY_BYTES * 3) / 4 / 1024 / 1024
        )} MiB of ZIP once base64-encoded) and submit again.`,
    });
  };

  if (hasDeclared && declared > MAX_REQUEST_BODY_BYTES) {
    tooLarge(declared);
    return undefined;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  // Iterated by hand rather than with `for await`: breaking out of a `for await` calls
  // the iterator's `return()`, which DESTROYS the stream and can lose the response we
  // just wrote. Driving `next()` leaves the socket intact.
  const iterator = req[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += buf.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      chunks.length = 0;
      tooLarge(total);
      return undefined;
    }
    chunks.push(buf);
  }

  if (hasDeclared && total < declared) {
    res.status(413).json({
      message:
        `Bundle payload was truncated in transit: ${declared} bytes were announced but ` +
        `${total} arrived. This endpoint accepts at most ${MAX_REQUEST_BODY_BYTES} bytes.`,
    });
    return undefined;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    res.status(400).json({ message: 'Invalid JSON' });
    return undefined;
  }
}

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
  const rateKey = `${REDIS_SYS_KEYS.BLOCKS.SUBMIT_RATE_LIMIT}:${rateSubject}` as const;
  // F3 — fail CLOSED, not open. If `exec()` returns null/short (Redis hiccup, MULTI
  // aborted), `Number(undefined)` is `NaN` and `NaN > max` is `false`, which would
  // let the request slip through un-limited. Treat a non-finite counter as "limiter
  // unavailable" and reject (503) rather than silently bypass — this is a heavy,
  // mod-gated bundle upload, so erring toward refusal is correct.
  //
  // withSysReadDeadline (#28): the raw sysRedis MULTI runs on the request's critical
  // path. On a SILENT half-open the written command parks in node-redis's reply queue
  // until OS TCP keepalive (~11min) — a HANG, not a throw. Racing the `.exec()` against
  // the sys read deadline (default REDIS_SYS_READ_TIMEOUT_MS=2000) turns that open-ended
  // hang into a clean rejection; the surrounding try/catch (mirrors dev-token) then fails
  // closed (503) instead of parking the submit indefinitely.
  let count: number;
  try {
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
    req.log?.warn('blocks/submit-version: rate limiter threw; failing closed', { rateSubject });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
  }
  if (!Number.isFinite(count)) {
    req.log?.warn('blocks/submit-version: rate-limit counter malformed; failing closed', {
      rateSubject,
    });
    res.status(503).json({ message: 'Rate limiter unavailable; please retry' });
    return;
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

  // 6. Read + validate the JSON body. `readJsonBody` owns the size refusal and has
  // already answered on the wire if it returns undefined.
  const body = await readJsonBody(req, res);
  if (body === undefined) return;

  // Same schema as the session route: bundleBase64 with the MAX_BUNDLE_SIZE_BYTES
  // pre-decode cap.
  const parsed = submitVersionSchema.safeParse(body);
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
