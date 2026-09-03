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
// 750MB. It matches the ceiling the DROPZONE callers of `useCFImageUpload` enforce
// client-side (`richTextEditor.maxFileSize`); the programmatic callers that upload
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
 * 🔴 This is a MEMORY bound, not a throughput target, and it is deliberately BELOW
 * the batch sizes callers use — the image dropzone defaults to 10 files and uploads
 * them concurrently. Shedding a legitimate request is therefore EXPECTED, not
 * exceptional, which is why the shed must not be terminal: the client retries once,
 * honouring `Retry-After`. If you raise this, raise it for a measured memory reason;
 * do not raise it to stop clients seeing 429s.
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
    // and a leaked slot is permanent — the route would wedge at 503 until the pod
    // restarts, which is a worse failure than the one the cap prevents.
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
 * 🔴 The 413 is written HERE, and the request is NOT destroyed.
 *
 * An earlier draft wrote the status and then called `req.destroy()`. Ordering was
 * necessary — a status written AFTER a destroy goes into a dead socket, does not
 * throw, reports `headersSent`, and the client sees a transport error instead of the
 * 413 — but it is not sufficient: `IncomingMessage.destroy()` tears down the SHARED
 * socket, and `socket.destroy()` DISCARDS queued writes rather than flushing them
 * (unlike `socket.end()`). On an idle socket a ~60-byte body usually lands inline, so
 * it looks fine; under backpressure the client still loses the status.
 *
 * Instead: set `Connection: close` and let the response flush, then simply stop
 * reading. Node closes the socket once the response is written, which is what tells
 * the client to stop sending — without racing the write we just made. We deliberately
 * do NOT drain the remainder with `req.resume()`: draining a body we rejected for
 * being too large is exactly the cost the cap exists to avoid.
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
  // exact socket teardown this function is trying to avoid, applied by the language
  // rather than by us. Measured: with `for await`, a destroy still lands right after
  // the 413 write. Driving `next()` by hand and simply not calling `return()` leaves
  // the socket intact so the response can flush; `Connection: close` then closes it
  // once the write is out.
  const iterator = req[Symbol.asyncIterator]();
  for (;;) {
    const { value, done } = await iterator.next();
    if (done) break;
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += buf.length;
    if (total > limit) {
      if (!res.headersSent) {
        res.setHeader('Connection', 'close');
        res.status(413).json({ error: 'File too large for the upload fallback' });
      }
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}
