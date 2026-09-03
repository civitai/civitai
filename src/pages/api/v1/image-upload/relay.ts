import type { NextApiRequest, NextApiResponse } from 'next';
import { isProd } from '~/env/other';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { isAllowedOriginRequest } from '~/server/utils/origin-helpers';
import { uploadImageBufferToStore } from '~/utils/s3-utils';

// FALLBACK upload path, for clients that cannot reach the storage host directly.
//
// The normal path is browser-direct: `/api/v1/image-upload` mints a key and returns
// a presigned PUT URL, and the browser PUTs straight at the storage endpoint. That
// endpoint is a raw storage hostname, not a civitai.com one, so a client whose DNS
// cannot resolve it gets `ERR_NAME_NOT_RESOLVED` on the PUT while every other
// request on the page succeeds — it presents as "uploads are broken for me
// specifically" (see the six reported instances behind this change).
//
// This route relays the bytes through an origin the client has demonstrably already
// resolved — it is talking to us — and performs the store write server-side. Same
// bucket, same backend, same storage-resolver registration, so the resulting object
// is servable exactly as a direct upload would be.
//
// 🔴 FALLBACK ONLY. Do NOT wire this in as the default upload path: every relayed
// byte transits the app servers, so making it the default moves the entire image
// upload bandwidth off the browser-to-storage path and onto us. The client only
// reaches for it after a direct PUT has already failed at the network layer.
//
// 🔴 The key is minted SERVER-SIDE (inside `uploadImageBufferToStore`) and this route
// deliberately accepts NO caller-supplied key. An earlier draft reused the id from
// the presign call so the two paths would agree; that lets a caller name any uuid it
// likes and overwrite another user's object, because the id travels through the
// browser. Minting here closes the overwrite entirely.
//
// ⚠ COST, not swept: when the fallback fires, the presign that preceded it has
// already registered its own key with `sizeBytes: 0` and no object was ever written
// to it. That row is NOT reclaimed by the existing orphan reconciliation, which
// lists bucket OBJECTS and diffs them against the registry — a registry row with no
// object is not in its universe. One stranded row per fallback. Left deliberately
// rather than deleted here, because the direct path also registers `sizeBytes: 0`
// for every SUCCESSFUL upload, so nothing may key a sweep on size alone.
//
// POST /api/v1/image-upload/relay   body: raw image bytes
// -> { id: <uuid key> }

export const config = {
  api: {
    // Raw bytes: the body is the file. `bodyParser` would try to parse it.
    bodyParser: false,
  },
};

// Bounds what this route will buffer in memory. NOT a general upload limit and NOT
// "the largest media the app accepts" — `constants.mediaUpload.maxVideoFileSize` is
// 750MB. It matches `constants.mediaUpload.maxImageFileSize`, which is what the
// DROPZONE callers of `useCFImageUpload` enforce client-side (`ImageUpload.tsx`,
// `SimpleImageUpload.tsx`) — THAT is the constant this must stay in sync with, not
// `richTextEditor.maxFileSize`, which happens to hold the same value today but is
// used by the rich-text editor rather than by any dropzone. The programmatic callers that upload
// generated blobs enforce nothing, so this is their only bound. Exists because this
// route buffers whole. A file above it cannot use the fallback; the direct path is
// unaffected.
export const MAX_RELAY_BYTES = 1024 * 1024 * 50;

/**
 * Ceiling on relays held in memory at once, PER POD.
 *
 * 8 x `MAX_RELAY_BYTES` is 400MB of body, and `Buffer.concat` roughly doubles that at
 * peak (see `readCappedBody`), so the real bound this sets is **~800MB** — survivable
 * beside a steady-state heap under the pod's memory limit, where an unbounded queue
 * is not. Buffers are external, so `--max-old-space-size` does not bound them and
 * this constant is the only thing that does.
 *
 * 🔴 This is a MEMORY bound, not a throughput target. ⚠ An earlier version of this
 * comment claimed a dropzone batch of 10 against a cap of 8 routinely sheds two, and
 * that shedding is therefore EXPECTED. That was wrong, and it inverted the action it
 * prescribed: the cap is PER POD (see below), `/api/v1/*` is served by a pool whose
 * replica floor is in the dozens, and there is no session affinity — so one browser's
 * concurrent POSTs are spread across pods and would all have to land on the SAME pod
 * to collide. A shed means ~8 concurrent relays hit one pod, which — for a fallback
 * that only fires for clients who cannot resolve the storage host — is an ANOMALY
 * worth investigating, not routine backpressure.
 *
 * The client still retries once on a shed, because a retry is cheap and a lost upload
 * is not. But do not read a 429 as normal, and if you raise this constant, raise it
 * for a measured memory reason rather than to make 429s go away.
 *
 * NOT env-configurable, which means it is not a runtime kill switch — changing it
 * needs a deploy. Left that way on purpose rather than adding an env var to the
 * repo-wide schema in this change; noted as a known gap.
 */
export const MAX_CONCURRENT_RELAYS = 8;

/** Seconds advertised in `Retry-After` when shedding, and honoured by the client. */
export const RELAY_RETRY_AFTER_SECONDS = 2;

/** In-flight relay count for this process. Module-scoped: per pod, not per cluster. */
let inFlight = 0;

/** Test seam — asserting the cap requires observing the counter. */
export function __getInFlightForTest() {
  return inFlight;
}

/**
 * Test seam — reset the counter between cases.
 *
 * Without this a case that leaves a slot held (a timeout, a mutant under test) makes
 * the NEXT case fail for a reason that has nothing to do with it. Measured during
 * round-2 mutation: a stuck shed test produced a false cascading failure in an
 * unrelated case two tests later.
 */
export function __resetInFlightForTest() {
  inFlight = 0;
}

export default async function imageUploadRelay(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution, matching the direct presign route.
  instrumentApiResponse(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // CSRF guard. This raw route bypasses the tRPC pipeline, so it never gets
  // createContext's same-origin check. It also accepts an arbitrary Content-Type,
  // which makes a cross-site POST a CORS-*simple* request — no preflight — so
  // without this any third-party page could make a logged-in visitor write
  // attacker-chosen bytes into the media bucket. The direct presign route is not
  // exposed this way (its presigned URL is unreadable cross-origin), so this is new
  // surface rather than parity.
  //
  // ⚠ NOT cookie-only, and the distinction matters. `getServerAuthSession` also
  // accepts `Authorization: Bearer <api key>` and `?token=`, and this route lives
  // under the public `/api/v1/` namespace. `blocks/submit-version.ts` uses the same
  // expression but IS cookie-only (`ModEndpoint`), which is why its comment says no
  // bearer exemption is needed — that justification does NOT transfer here.
  // 🔴 FULL PATH, because there are two: `src/pages/api/blocks/submit-version.ts` is
  // the one meant. Its `/api/v1/` sibling is BEARER-only and deliberately OMITS the
  // origin guard entirely (it would break the headless CLI, which sends no Origin) —
  // i.e. the nearer-looking precedent argues the OPPOSITE of this paragraph.
  // `createContext.ts` does exempt bearer callers, deriving `isBearerAuth` from an
  // apiKeyId that only exists AFTER the session lookup.
  //
  // So this check is deliberately WIDER than either precedent: it 403s an API-key
  // client with no Origin. Chosen on purpose — the relay exists to rescue BROWSERS
  // whose DNS cannot resolve the storage host, and a non-browser client has neither
  // that failure mode nor any reason to push bytes through us instead of straight at
  // the store. It runs BEFORE the session lookup so an unauthenticated cross-origin
  // probe costs nothing. Revisit both the placement and this paragraph together if a
  // bearer client ever needs the fallback.
  if (isProd && !isAllowedOriginRequest(req)) {
    res.status(403).json({ error: 'Cross-origin request blocked' });
    return;
  }

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // 🔴 Bound the memory this route can hold at once. It buffers whole, and
  // `Buffer.concat` allocates a second copy while the chunk array is still live, so
  // peak is ~2x the body — Buffers are external, so `--max-old-space-size` does not
  // bound them and only the pod's memory limit does. Without a cap, N concurrent
  // max-size relays are an OOMKill of the whole pod, taking every unrelated request
  // on it down too. Shedding here is strictly better: the client keeps its original
  // error and the direct path is untouched.
  if (inFlight >= MAX_CONCURRENT_RELAYS) {
    // 🔴 429, NOT 503. `instrumentApiResponse` counts every `status >= 500` into
    // `civitai_app_http_errors_total`, so shedding with a 5xx makes deliberate,
    // healthy load-shedding indistinguishable from a server fault in this route's
    // own error attribution — the same reasoning that makes `handleEndpointError`
    // map a client disconnect to 499. 429 is also the honest semantic: the request
    // was fine, there was no capacity for it right now.
    res.setHeader('Retry-After', String(RELAY_RETRY_AFTER_SECONDS));
    res.status(429).json({ error: 'Upload fallback is busy' });
    return;
  }

  inFlight += 1;
  try {
    let body: Buffer;
    try {
      body = await readCappedBody(req, res, MAX_RELAY_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        // The 413 was already written by `readCappedBody` — see the note there.
        return;
      }
      res.status(400).json({ error: 'Failed to read upload body' });
      return;
    }

    if (body.length === 0) {
      res.status(400).json({ error: 'Empty upload body' });
      return;
    }

    const contentTypeHeader = req.headers['content-type'];
    const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] : contentTypeHeader;

    try {
      // `uploadImageBufferToStore` returns { key, backend }; the direct presign route
      // calls the same value `id` in its response, so keep the wire shape identical.
      const { key } = await uploadImageBufferToStore(body, { contentType });
      res.status(200).json({ id: key });
    } catch (e) {
      // 🔴 NOT `error.message`. This path's errors come from the AWS SDK's
      // PutObjectCommand, whose messages carry bucket names, endpoint hostnames,
      // request ids and signature detail — returning them verbatim discloses
      // infrastructure to any logged-in caller, and puts this route on the
      // rest-error-envelope ledger's offender set. `handleEndpointError` genericises
      // the wire body, logs the real cause, and maps a client disconnect to 499 so it
      // stays out of the 5xx SLO.
      handleEndpointError(res, e);
    }
  } finally {
    // `finally`, not a tail decrement: every early `return` above is inside the try,
    // and a leaked slot is permanent — the route would wedge, shedding every request
    // with 429 until the pod restarts, which is a worse failure than the one the cap
    // prevents.
    inFlight -= 1;
  }
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super('Payload too large');
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Buffer the request body, aborting as soon as it exceeds `limit`.
 *
 * The check is on the RUNNING total rather than on the finished buffer: the point is
 * to stop allocating, so a caller cannot spend our memory by streaming an
 * arbitrarily large body that we only measure at the end. `Content-Length` is not
 * trusted for this — it is caller-supplied and may be absent under chunked encoding.
 *
 * 🔴 The 413 is written HERE, and then the remainder is DRAINED. Both halves are
 * required, and this is the third attempt at it — the first two were measured wrong.
 *
 * Attempt 1 wrote the status and then called `req.destroy()`. `IncomingMessage`'s
 * destroy tears down the SHARED socket, and `socket.destroy()` DISCARDS queued writes
 * rather than flushing them, so the client got ECONNRESET instead of the status.
 *
 * Attempt 2 removed the destroy and set `Connection: close` instead, reasoning that
 * the response would flush and the close would tell the client to stop. It does not:
 * `res.end()` on a `Connection: close` response sets `_last`, `resOnFinish` calls
 * `socket.destroySoon()`, and closing a socket that still has unread inbound data
 * RSTs — losing the status the same way, with a different errno.
 *
 * Measured against a real HTTP client, 5 runs per arm, chunked and Content-Length:
 *
 *     req.destroy()                    -> ECONNRESET, no 413        5/5
 *     Connection: close, stop reading  -> EPIPE,      no 413        5/5
 *     Connection: close + resume       -> EPIPE,      no 413        3/3
 *     req.resume()                     -> 413 + JSON body           5/5
 *
 * So the drain is the ONLY arm that delivers the status, and `Connection: close` is
 * the ingredient that breaks it. An earlier version of this comment refused the drain
 * on cost grounds; that reasoning conflated two costs. Draining does NOT buffer —
 * `resume()` reads and discards, so memory stays flat, which is the cost the cap
 * exists to bound. What it does spend is time on the wire for bytes we are throwing
 * away, and the in-flight slot is held while we do it. That is the trade being made
 * knowingly: a bounded bandwidth cost on an already-rejected request, in exchange for
 * the caller learning WHY it was rejected.
 *
 * ⚠ Measured at the pod hop only. In production Traefik sits in front, and
 * `Connection` is hop-by-hop, so what a browser finally sees is NOT established here.
 * The unit test cannot see any of this either — it drives a `Readable.from` and an
 * object literal, which have no socket — so it pins the CALL, never the delivery.
 */
async function readCappedBody(
  req: NextApiRequest,
  res: NextApiResponse,
  limit: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  // 🔴 Iterated MANUALLY rather than with `for await`. Breaking out of a `for await`
  // invokes the iterator's `return()`, which DESTROYS the underlying stream — the
  // exact socket teardown that loses the status, applied by the language rather than
  // by us. Measured: with `for await`, a destroy lands right after the 413 write.
  // Driving `next()` by hand and never calling `return()` leaves the socket intact so
  // the response can flush and the drain below can run.
  const iterator = req[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += buf.length;
    if (total > limit) {
      if (!res.headersSent) {
        // NO `Connection: close` — measured, it is what destroys the socket before
        // the status reaches the client. See the note above.
        res.status(413).json({ error: 'File too large for the upload fallback' });
      }
      // Release the buffered chunks BEFORE draining: the drain can take a while on a
      // large body and there is no reason to hold what we already rejected.
      chunks.length = 0;
      // Drain and discard, so the response can be delivered rather than RST away.
      // `resume()` does not buffer.
      req.resume();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}
