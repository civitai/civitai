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

/**
 * The size at which Next TRUNCATES a request body, silently.
 *
 * 🔴 This is a property of the framework, not a choice of ours, and it is the reason
 * this route cannot simply pick its own limit. Next 16 caps the body it will hand a
 * route at 10MB by default and then just ENDS the stream — the route sees a clean
 * end-of-body, not an error. `next.config.mjs` does not set
 * `middlewareClientMaxBodySize`, so the default applies.
 *
 * Measured on a deployed preview (Next 16.3.1), sent vs what actually reached the
 * store, reproduced BOTH through the ingress and by POSTing from inside the container
 * straight at the app port — so it is the framework, not a proxy in front:
 *
 *     sent 10,485,760 -> stored 10,485,760   intact
 *     sent 12,000,000 -> stored 10,438,916   TRUNCATED
 *     sent 20,000,000 -> stored 10,483,999   TRUNCATED
 *     sent 55,000,000 -> stored 10,479,830   TRUNCATED
 *
 * The cut is ragged, which is the tell that it is a stream ending early rather than a
 * fixed-size cap. Before the guards below, a valid 14,523,378-byte PNG relayed as a
 * 10,485,209-byte object with no `IEND` terminator — `magick` rejects it with
 * `unexpected end-of-file` — while the route returned `200 {"id": …}`. A corrupt image
 * reported to the user as a successful upload.
 */
export const NEXT_BODY_TRUNCATION_BYTES = 1024 * 1024 * 10;

/**
 * Bounds what this route will buffer in memory, and what it will accept at all.
 *
 * 🔴 Pinned to `NEXT_BODY_TRUNCATION_BYTES` deliberately. It used to be 50MB, to match
 * `constants.mediaUpload.maxImageFileSize` (what the DROPZONE callers of
 * `useCFImageUpload` enforce client-side — `ImageUpload.tsx`, `SimpleImageUpload.tsx`).
 * That constant was UNREACHABLE: Next truncated at 10MB first, so the cap never bound
 * and the 413 branch below was dead code.
 *
 * Raising this above the truncation point requires raising
 * `middlewareClientMaxBodySize` in `next.config.mjs` IN THE SAME CHANGE — that is a
 * repo-wide widening of how large a body every route may receive, so it was not done
 * here. It buys little: sampled 111,097 rows of `Image.metadata->>'size'`, **0.679%**
 * of images exceed 10MB (p99 = 7.63MB), and this is a fallback that only fires for
 * clients who cannot resolve the storage host at all. Those few now get an honest 413
 * instead of a silently corrupted file.
 *
 * ⚠ Video is a different population — 17.1% of sampled videos exceed 10MB — so if this
 * route is ever put on a video path, revisit this and the config knob together.
 *
 * A file above this cannot use the fallback; the direct path is unaffected.
 */
export const MAX_RELAY_BYTES = NEXT_BODY_TRUNCATION_BYTES;

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
      if (e instanceof PayloadTooLargeError || e instanceof TruncatedBodyError) {
        // The 413 / 400 was already written by `readCappedBody` — see the notes there.
        // 🔴 Returning here is what skips the store write: neither a refused nor an
        // incomplete body may reach `uploadImageBufferToStore`.
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
 * The request body ended before the client's declared `Content-Length`.
 *
 * Distinct from `PayloadTooLargeError` on purpose: that one means we refused the
 * request, this one means we could not trust what we received. Both must skip the
 * store write, and both have already written their own status.
 */
export class TruncatedBodyError extends Error {
  constructor() {
    super('Request body was truncated');
    this.name = 'TruncatedBodyError';
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
 * 🔴 The 413 is written HERE, and NOTHING is done to the socket afterwards. Both
 * halves matter, and this is the fourth attempt — the first three were each measured
 * wrong, so the arms are recorded rather than the conclusion.
 *
 * Attempt 1 wrote the status then called `req.destroy()`. That tears down the SHARED
 * socket and discards queued writes rather than flushing them: ECONNRESET, no status.
 *
 * Attempt 2 removed the destroy and set `Connection: close`. Also loses it: `res.end()`
 * on a close-delimited response sets `_last`, `resOnFinish` calls `socket.destroySoon()`,
 * and closing a socket with unread inbound data RSTs. EPIPE, no status.
 *
 * Attempt 3 kept `Connection: close` off AND added `req.resume()` to drain, believing
 * the drain was what delivered the status. It is not, and the resume was INERT:
 * `readCappedBody` drives the stream's async iterator, which keeps a `'readable'`
 * listener registered, and `Readable.resume()` is a no-op while `readableListening` is
 * true — it sets `flowing = false` and the stream stays paused.
 *
 * Measured against a real HTTP client, Node 24.19.0, 5 runs per arm, 64MB body / 1MB
 * limit — note the middle two rows are IDENTICAL, which is what settles it:
 *
 *     req.destroy()                      -> ECONNRESET, no 413      5/5
 *     Connection: close                  -> EPIPE,      no 413      5/5
 *     neither (this code)                -> 413 + body              5/5, 3.7MB read
 *     neither + req.resume()             -> 413 + body              5/5, 3.7MB read
 *     neither + a REAL drain             -> 413 + body              5/5, 64MB read
 *
 * So: NOT closing the connection is the entire fix. The drain was removed because it
 * bought nothing — and a real one (clearing the iterator's listener first) would pull
 * the whole rejected body over the wire, which is a cost worth NOT paying for a request
 * we have already refused. The client gets its status either way; the unread remainder
 * simply back-pressures and the socket closes on the keep-alive path a few seconds later.
 *
 * ⚠ The in-flight slot is NOT held for any of this: the throw below returns through the
 * `finally` that releases it, measured at ~2ms. A slow client cannot hold a slot by
 * dribbling a rejected body.
 *
 * ⚠ Measured at the pod hop only. Traefik sits in front in production and `Connection`
 * is hop-by-hop, so what a browser finally sees is NOT established here. The unit test
 * cannot see delivery either — it drives a `Readable.from` and an object literal — so it
 * pins the calls this measurement showed matter, and nothing more.
 */
async function readCappedBody(
  req: NextApiRequest,
  res: NextApiResponse,
  limit: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  // Declared length, when the client sends one. `fetch` with a `File`/`Blob` body
  // always does, which is every real caller of this route; chunked senders will not,
  // hence every use below is conditional.
  const declaredRaw = req.headers['content-length'];
  const declared = Number(Array.isArray(declaredRaw) ? declaredRaw[0] : declaredRaw);
  const hasDeclared = Number.isInteger(declared) && declared >= 0;

  // 🔴 Reject an over-size body BEFORE reading a byte of it.
  //
  // This is what makes the 413 reachable at all. Next truncates at
  // `NEXT_BODY_TRUNCATION_BYTES` (see that constant), so once `limit` is at the
  // truncation point the running-total check below can never trip — the stream ends
  // at the cap instead of exceeding it. Reading the DECLARED length gets us the
  // refusal before the framework silently cuts anything, and costs no buffering.
  //
  // Trusting `Content-Length` to REJECT is safe in a way trusting it to ACCEPT is not:
  // a client that under-declares still gets caught by the running-total check, and a
  // client that over-declares only harms itself. That asymmetry is why this does not
  // contradict the note about not trusting the header for the cap.
  if (hasDeclared && declared > limit) {
    if (!res.headersSent) {
      res.status(413).json({ error: 'File too large for the upload fallback' });
    }
    throw new PayloadTooLargeError();
  }

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
        // NO `Connection: close`, and NO drain. Measured: the close is what destroys
        // the socket before the status reaches the client, and the drain is inert here
        // (and pointless if made real). See the note above.
        res.status(413).json({ error: 'File too large for the upload fallback' });
      }
      // Drop what we buffered — we have rejected it and are about to unwind.
      chunks.length = 0;
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }

  // 🔴 The body ended EARLY — never store a partial object.
  //
  // Next's truncation is indistinguishable from a clean end-of-body at the stream
  // level: no error, no event, the iterator simply reports `done`. Without this check
  // the route buffers the fragment, treats it as the whole file, PUTs it and returns
  // `200 {"id": …}` — the caller is told the upload succeeded and gets a permanently
  // corrupt image. That is strictly worse than the failure this route exists to fix,
  // because a failed direct PUT is at least visible.
  //
  // Comparing against the declared length is the only signal available here. It also
  // catches a client that died mid-upload, which deserves the same treatment: we did
  // not receive the file, so we must not write one.
  //
  // 400 rather than 413 — the request was not too large (that is refused above,
  // before reading), it was incomplete. Distinguishing them keeps a truncation
  // regression from hiding inside the size-limit case.
  if (hasDeclared && total < declared) {
    if (!res.headersSent) {
      res.status(400).json({ error: 'Upload body was incomplete' });
    }
    chunks.length = 0;
    throw new TruncatedBodyError();
  }

  return Buffer.concat(chunks);
}
