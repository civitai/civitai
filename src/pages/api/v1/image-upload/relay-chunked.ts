import type { NextApiRequest, NextApiResponse } from 'next';
import { constants } from '~/server/common/constants';
import { logToAxiom } from '~/server/logging/client';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import {
  recordImageUploadRelay,
  type ImageUploadRelayOutcome,
} from '~/server/prom/image-upload-relay.metrics';
import { trackImageUpload } from '~/server/services/image-upload-action.service';
import { recordUploadKeyOwner } from '~/server/services/image-url-ownership';
import {
  type ImageUploadRelaySession,
  createRelaySession,
  deleteRelaySession,
  getOwnedRelaySession,
  recordRelaySessionPart,
} from '~/server/services/image-upload-relay-session.service';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import {
  IMAGE_UPLOAD_RELAY_PRODUCER_HEADER,
  sanitizeImageUploadRelayProducer,
  type ImageUploadRelayProducer,
} from '~/utils/image-upload-relay-producer';
import {
  abortImageMultipartToStore,
  classifyS3MultipartError,
  completeImageMultipartToStore,
  startImageMultipartToStore,
  uploadImagePartToStore,
} from '~/utils/s3-utils';
import {
  authorizeRelayRequest,
  PayloadTooLargeError,
  readCappedBody,
  releaseRelaySlot,
  TruncatedBodyError,
  tryAcquireRelaySlot,
} from '~/pages/api/v1/image-upload/relay';

// CHUNKED variant of the upload relay (`relay.ts`), for images larger than one request body can
// carry through this path. Same fallback-only contract, same auth/origin guard, same per-pod
// buffering slots, same counter: read `relay.ts` first.
//
// The body cap that bounds `relay.ts` (Next truncates `/api/v1/*` bodies at 10 MiB) is per
// REQUEST, so a larger file goes up as a server-side multipart upload, one piece per request:
//
//   POST ?action=start&size=<bytes>            -> { session, pieceSize, partCount }
//   POST ?action=part&session=<id>&part=<n>    body: exactly piece n's bytes
//   POST ?action=complete&session=<id>         -> { id: <uuid key> }   (same shape as relay.ts)
//   POST ?action=abort&session=<id>
//
// 🔴 The storage key and uploadId never leave the server before `complete`: `session` is an
// opaque id bound to the caller's userId in sysRedis (see image-upload-relay-session.service).

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Bytes per piece. Under `MAX_RELAY_BYTES` (the truncation point, and what the shared slots were
 * sized against) and at least the 5 MiB S3 minimum for every part but the last.
 */
export const CHUNKED_RELAY_PIECE_BYTES = 8 * 1024 * 1024;

/**
 * The largest image the relay accepts at all; the dropzone callers enforce the same cap. It also
 * bounds the part count: `partCount` is derived here from the capped size, and a part number
 * outside it is refused.
 */
export const CHUNKED_RELAY_MAX_BYTES = constants.mediaUpload.maxImageFileSize;

/** One emit per invocation, by construction — the same split as `relay.ts`'s handler. */
export default async function imageUploadRelayChunked(req: NextApiRequest, res: NextApiResponse) {
  instrumentApiResponse(req, res);
  const producer = sanitizeImageUploadRelayProducer(
    req.headers[IMAGE_UPLOAD_RELAY_PRODUCER_HEADER]
  );

  let outcome: ImageUploadRelayOutcome;
  try {
    outcome = await runChunkedRelay(req, res, producer);
  } catch (e) {
    recordImageUploadRelay('handler_error', producer);
    throw e;
  }
  recordImageUploadRelay(outcome, producer);
}

async function runChunkedRelay(
  req: NextApiRequest,
  res: NextApiResponse,
  producer: ImageUploadRelayProducer
): Promise<ImageUploadRelayOutcome> {
  const auth = await authorizeRelayRequest(req, res);
  if ('outcome' in auth) return auth.outcome;
  const { userId } = auth;

  switch (firstValue(req.query.action)) {
    case 'start':
      return startSession(req, res, userId);
    case 'part':
      return storePart(req, res, userId);
    case 'complete':
      return completeSession(req, res, userId, producer);
    case 'abort':
      return abortSession(req, res, userId);
    default:
      res.status(400).json({ error: 'Unknown relay step' });
      return 'bad_request';
  }
}

async function startSession(
  req: NextApiRequest,
  res: NextApiResponse,
  userId: number
): Promise<ImageUploadRelayOutcome> {
  const size = Number(firstValue(req.query.size));
  if (!Number.isInteger(size) || size <= 0) {
    res.status(400).json({ error: 'Invalid upload size' });
    return 'bad_request';
  }
  if (size > CHUNKED_RELAY_MAX_BYTES) {
    res.status(413).json({ error: 'File too large for the upload fallback' });
    return 'too_large';
  }
  const partCount = Math.ceil(size / CHUNKED_RELAY_PIECE_BYTES);
  const contentType = firstValue(req.headers['content-type']);

  try {
    const { key, uploadId } = await startImageMultipartToStore({ contentType });
    let session: string;
    try {
      session = await createRelaySession({
        userId,
        key,
        uploadId,
        size,
        pieceSize: CHUNKED_RELAY_PIECE_BYTES,
        partCount,
      });
    } catch (e) {
      // Nobody can ever address this multipart upload again, so close it here.
      await abortImageMultipartToStore({ key, uploadId }).catch(() => undefined);
      throw e;
    }
    res.status(200).json({ session, pieceSize: CHUNKED_RELAY_PIECE_BYTES, partCount });
    return 'chunk_started';
  } catch (e) {
    handleEndpointError(res, e);
    return 'store_error';
  }
}

async function storePart(
  req: NextApiRequest,
  res: NextApiResponse,
  userId: number
): Promise<ImageUploadRelayOutcome> {
  const sessionId = firstValue(req.query.session);
  let session: ImageUploadRelaySession | null;
  try {
    session = await getOwnedRelaySession(sessionId, userId);
  } catch (e) {
    handleEndpointError(res, e);
    return 'store_error';
  }
  if (!session || !sessionId) return sessionNotFound(res);

  const partNumber = Number(firstValue(req.query.part));
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) {
    res.status(400).json({ error: 'Invalid part number' });
    return 'bad_request';
  }
  const expected =
    partNumber < session.partCount
      ? session.pieceSize
      : session.size - session.pieceSize * (session.partCount - 1);

  // A declared length is checked against the plan before reading; an over-declared piece falls
  // through to `readCappedBody`'s 413. It is optional because a proxy hop may forward the body
  // without one — the byte-count check after the read is what holds either way.
  const declaredRaw = firstValue(req.headers['content-length']);
  if (declaredRaw !== undefined) {
    const declared = Number(declaredRaw);
    if (!Number.isInteger(declared) || declared < expected) {
      res.status(400).json({ error: 'Piece length does not match the upload plan' });
      return 'bad_request';
    }
  }

  if (!tryAcquireRelaySlot(res)) return 'busy';
  try {
    let body: Buffer;
    try {
      body = await readCappedBody(req, res, expected);
    } catch (e) {
      if (e instanceof PayloadTooLargeError) return 'too_large';
      if (e instanceof TruncatedBodyError) return 'truncated';
      res.status(400).json({ error: 'Failed to read upload body' });
      return 'read_error';
    }
    // 🔴 The piece must be EXACTLY its planned size. With no declared length this is the only
    // thing that tells Next's silent truncation from a clean end-of-body; a longer body was
    // already refused by the cap above.
    if (body.length !== expected) {
      res.status(400).json({ error: 'Upload body was incomplete' });
      return 'truncated';
    }

    try {
      const etag = await uploadImagePartToStore({
        key: session.key,
        uploadId: session.uploadId,
        partNumber,
        body,
      });
      await recordRelaySessionPart(sessionId, partNumber, etag);
    } catch (e) {
      handleEndpointError(res, e);
      return 'store_error';
    }
    res.status(200).json({ part: partNumber });
    return 'chunk_stored';
  } finally {
    releaseRelaySlot();
  }
}

async function completeSession(
  req: NextApiRequest,
  res: NextApiResponse,
  userId: number,
  producer: ImageUploadRelayProducer
): Promise<ImageUploadRelayOutcome> {
  const sessionId = firstValue(req.query.session);
  try {
    const session = await getOwnedRelaySession(sessionId, userId);
    if (!session || !sessionId) return sessionNotFound(res);

    const parts: { ETag: string; PartNumber: number }[] = [];
    for (let n = 1; n <= session.partCount; n++) {
      const etag = session.etags.get(n);
      if (!etag) {
        res.status(400).json({ error: 'Upload is missing parts' });
        return 'bad_request';
      }
      parts.push({ ETag: etag, PartNumber: n });
    }

    // `size` is safe to register as the object's size: every part was length-checked against
    // the plan derived from it before it was stored.
    let key: string;
    try {
      ({ key } = await completeImageMultipartToStore({
        key: session.key,
        uploadId: session.uploadId,
        parts,
        totalBytes: session.size,
      }));
    } catch (e) {
      // Already completed or aborted at the store (a cancel racing this complete): terminal,
      // so 409 like `/api/upload/complete`, and the session can never be used again.
      if (classifyS3MultipartError(e) !== 'not-found') throw e;
      await deleteRelaySession(sessionId).catch(() => undefined);
      res.status(409).json({ error: 'Upload already finalized or aborted' });
      return 'upload_gone';
    }
    // The TTL reaps it if this fails; the object is stored either way.
    await deleteRelaySession(sessionId).catch(() => undefined);
    trackImageUpload(req, res, key);
    await recordUploadKeyOwner(key, userId);
    res.status(200).json({ id: key });
    try {
      await logToAxiom({
        name: 'image-upload-relayed',
        userId,
        bytes: session.size,
        producer,
        parts: session.partCount,
      });
    } catch {
      /* the bytes are already stored — telemetry must not fail the route */
    }
    return 'success';
  } catch (e) {
    handleEndpointError(res, e);
    return 'store_error';
  }
}

async function abortSession(
  req: NextApiRequest,
  res: NextApiResponse,
  userId: number
): Promise<ImageUploadRelayOutcome> {
  const sessionId = firstValue(req.query.session);
  try {
    const session = await getOwnedRelaySession(sessionId, userId);
    if (!session || !sessionId) return sessionNotFound(res);
    try {
      await abortImageMultipartToStore({ key: session.key, uploadId: session.uploadId });
    } catch (e) {
      // Already gone at the store: the abort's goal holds, so it is idempotent success.
      if (classifyS3MultipartError(e) !== 'not-found') throw e;
    }
    await deleteRelaySession(sessionId);
    res.status(200).json({ ok: true });
    return 'chunk_aborted';
  } catch (e) {
    handleEndpointError(res, e);
    return 'store_error';
  }
}

function sessionNotFound(res: NextApiResponse): ImageUploadRelayOutcome {
  res.status(404).json({ error: 'Upload session not found' });
  return 'session_invalid';
}

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
