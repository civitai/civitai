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
// far larger. It matches the ceiling every current caller of `useCFImageUpload`
// already enforces client-side, and exists because this route buffers whole.
// A file above it cannot use the fallback; the direct path is unaffected.
export const MAX_RELAY_BYTES = 1024 * 1024 * 50;

/**
 * Ceiling on relays held in memory at once, PER POD.
 *
 * At `MAX_RELAY_BYTES` and ~2x peak amplification this bounds the route at roughly
 * 400MB — survivable beside a steady-state heap on the pod's limit, where an
 * unbounded queue is not. Deliberately small: this is a fallback that only fires for
 * clients who cannot reach the storage host, so sustained high concurrency here is
 * itself the anomaly rather than the expected load.
 *
 * NOT env-configurable, which means it is not a runtime kill switch — changing it
 * needs a deploy. Left that way on purpose rather than adding an env var to the
 * repo-wide schema in this change; noted as a known gap.
 */
export const MAX_CONCURRENT_RELAYS = 8;

/** In-flight relay count for this process. Module-scoped: per pod, not per cluster. */
let inFlight = 0;

/** Test seam — asserting the cap requires observing the counter. */
export function __getInFlightForTest() {
  return inFlight;
}

export default async function imageUploadRelay(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution, matching the direct presign route.
  instrumentApiResponse(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // CSRF guard. This raw route is cookie-authenticated and bypasses the tRPC
  // pipeline, so it never gets createContext's same-origin check. It also accepts an
  // arbitrary Content-Type, which makes a cross-site POST a CORS-*simple* request —
  // no preflight — so without this any third-party page could make a logged-in
  // visitor write attacker-chosen bytes into the media bucket. The direct presign
  // route is not exposed this way (its presigned URL is unreadable cross-origin), so
  // this is new surface rather than parity. Mirrors the posture and the !isProd
  // exemption of `blocks/submit-version.ts`, which is the in-repo precedent.
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
    res.setHeader('Retry-After', '5');
    res.status(503).json({ error: 'Upload fallback is busy' });
    return;
  }

  inFlight += 1;
  try {
    let body: Buffer;
    try {
      body = await readCappedBody(req, res, MAX_RELAY_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) {
        // The 413 was already written by `readCappedBody`, before the socket was torn
        // down — see the comment there for why the order matters.
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
 * 🔴 The 413 is written HERE, before `req.destroy()`. Destroying the request tears
 * down the socket, and a `res.status(413)` afterwards writes into a dead socket: it
 * does not throw, it reports `headersSent`, and the client sees a transport-level
 * connection error instead of the status. Ordering is the whole fix — the caller
 * must learn the file was too large, not that the connection broke.
 */
async function readCappedBody(
  req: NextApiRequest,
  res: NextApiResponse,
  limit: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      if (!res.headersSent) {
        res.status(413).json({ error: 'File too large for the upload fallback' });
      }
      // Only now stop the client from streaming into a request we have abandoned.
      req.destroy();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}
