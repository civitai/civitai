import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
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
// browser. Minting here costs one orphaned zero-byte registration from the presign
// that preceded the fallback — which the storage-resolver orphan reconciliation
// already sweeps — and closes the overwrite entirely.
//
// POST /api/v1/image-upload/relay   body: raw image bytes
// -> { id: <uuid key> }

export const config = {
  api: {
    // Raw bytes: the body is the file. `bodyParser` would try to parse it.
    bodyParser: false,
  },
};

// Matches `constants.richTextEditor.maxFileSize` (50MB), the largest media size the
// app already accepts elsewhere. NOTE this is a cap the DIRECT path does not have —
// a presigned PUT is bounded by the storage backend, not by us — so a file above
// this size cannot use the fallback. That is a deliberate limit on a relay that
// buffers in memory, not a general upload limit.
export const MAX_RELAY_BYTES = 1024 * 1024 * 50;

export default async function imageUploadRelay(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution, matching the direct presign route.
  instrumentApiResponse(req, res);

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId || session.user?.bannedAt) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let body: Buffer;
  try {
    body = await readCappedBody(req, MAX_RELAY_BYTES);
  } catch (e) {
    if (e instanceof PayloadTooLargeError) {
      res.status(413).json({ error: 'File too large for the upload fallback' });
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
    const error = e as Error;
    res.status(500).json({ error: error.message ?? 'Upload failed' });
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
 */
async function readCappedBody(req: NextApiRequest, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      // Stop the client from continuing to send into a request we have abandoned.
      req.destroy();
      throw new PayloadTooLargeError();
    }
    chunks.push(buf);
  }

  return Buffer.concat(chunks);
}
