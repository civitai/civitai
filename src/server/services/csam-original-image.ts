import { createHash } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { isAllowedImageScanUrl } from '~/server/utils/image-scan-url';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { getImageUploadBackend } from '~/utils/s3-utils';

/*
 * Reads the bytes a user uploaded, for CSAM evidence (report archive and NCMEC upload).
 * 🔴 IMPORT-GUARDED by `no-csam-original-image-import.test.ts`: it bypasses every delivery-side
 * control (edge, NSFW level, moderation), so it must not become a general "serve the original" helper.
 */

export type OriginalImageSource = 'original' | 'edge-fallback' | 'missing';

export type OriginalImage = {
  source: 'original' | 'edge-fallback';
  data: Buffer;
  contentType: string;
  sha256: string;
  /** Returns the byte reservation, if one was taken. Safe to call more than once. */
  release: () => void;
};

export type MissingImage = { source: 'missing'; reason: string };

export type OriginalImageRead = OriginalImage | MissingImage;

type ImageInput = { id?: number; url: string; type: MediaType; mimeType?: string | null };
/** `backend` is a label for diagnostics only (never the bucket or the key). */
type ImageBackend = { s3: S3Client; bucket: string; backend?: string };
type ReadOptions = { backend?: ImageBackend; fetchImpl?: typeof fetch };

/** Long enough for a maximum-size original. */
export const ORIGINAL_IMAGE_READ_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Attempts at a stored object, each a fresh request: a body that dies mid-stream cannot be resumed.
 * Only a dropped connection is retried here (see `isDroppedConnection`); the SDK already retries an
 * error RESPONSE (5xx, throttling) inside each `send`, but not a body that fails after its headers.
 */
export const ORIGINAL_IMAGE_READ_ATTEMPTS = 3;

/** Wait before attempt N+1, indexed by N-1. */
export const ORIGINAL_IMAGE_RETRY_DELAYS_MS = [2_000, 8_000];

const DROPPED_CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);
// Node's IncomingMessage reports a response cut off mid-body as `Error: aborted`.
const DROPPED_CONNECTION_MESSAGES = new Set(['aborted', 'socket hang up']);

/**
 * A connection that dropped, as opposed to an answer from storage. Our own timeout is not one: it
 * already waited the full read timeout, and retrying it would hold the slot for multiples of that.
 */
function isDroppedConnection(e: unknown): boolean {
  for (let error = e, depth = 0; error && typeof error === 'object' && depth < 3; depth++) {
    const { name, code, message, cause } = error as {
      name?: unknown;
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (name === 'AbortError' || name === 'TimeoutError') return false;
    if (typeof code === 'string' && DROPPED_CONNECTION_CODES.has(code)) return true;
    if (typeof message === 'string' && DROPPED_CONNECTION_MESSAGES.has(message)) return true;
    error = cause;
  }
  return false;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const PROBE_TIMEOUT_MS = 60 * 1000;

/** A larger object or response is not an image we stored. */
export const MAX_ORIGINAL_IMAGE_BYTES = 1024 * 1024 * 1024;

const OCTET_STREAM = 'application/octet-stream';

/** Reserved for a body of unknown length, so it cannot slip under a byte budget. */
const UNKNOWN_SIZE = MAX_ORIGINAL_IMAGE_BYTES;

const OVER_CAP = 'exceeds the size cap';

/**
 * Zip entry extensions for the media types we store. The stored content type is whatever the
 * uploading client declared, so anything else is archived as `.bin` rather than under an
 * extension a reviewer's machine might execute.
 */
const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);
const ABSENT_STATUSES = new Set([404, 410]);

// Only NoSuchKey: a plain 404 is also what a wrong bucket returns, and that must not quietly turn
// every original into an edge copy.
const isMissingObject = (e: unknown) => (e as { name?: string } | undefined)?.name === 'NoSuchKey';
// A HEAD has no error body, so a missing key is only `NotFound`, and so is a wrong bucket. That
// passes the probe; the read then throws.
const isMissingHead = (e: unknown) =>
  isMissingObject(e) || (e as { name?: string } | undefined)?.name === 'NotFound';

const missing = (reason: string): MissingImage => ({ source: 'missing', reason });

class OverCapError extends Error {}

function pickContentType(...candidates: (string | null | undefined)[]) {
  for (const candidate of candidates) {
    const type = candidate?.split(';')[0].trim().toLowerCase();
    if (type && type !== OCTET_STREAM && /^[a-z]+\/[a-z0-9.+-]{1,64}$/.test(type)) return type;
  }
  return OCTET_STREAM;
}

export function extensionForContentType(contentType: string) {
  return MEDIA_EXTENSIONS[contentType] ?? 'bin';
}

const destroyBody = (body: unknown) => (body as { destroy?: () => void }).destroy?.();

async function readCapped(body: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > MAX_ORIGINAL_IMAGE_BYTES) throw new OverCapError(OVER_CAP);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const declaredLength = (header: string | null) => {
  const length = Number(header || NaN);
  return Number.isFinite(length) && length >= 0 ? length : UNKNOWN_SIZE;
};

function edgeRefusal(url: string, passthrough: boolean) {
  if (!isAllowedImageScanUrl(url)) return missing('url not allowed');
  // A stored key is joined into the edge URL as is: it must stay a plain path. Minted keys hold no %.
  if (!passthrough && /\.\.|%|[?#]/.test(url)) return missing('url not allowed');
}

/**
 * The edge's full-size copy, never a resized one. `missing` for a 404/410, a body that is not
 * media, or a length over the cap; any other failure throws.
 */
async function fetchEdge(
  image: ImageInput,
  passthrough: boolean,
  fetchImpl: typeof fetch,
  timeoutMs: number
) {
  let response: Response;
  try {
    // A stored full URL is fetched as is, so it must not redirect somewhere we did not vet.
    response = await fetchImpl(getEdgeUrl(image.url, { type: image.type }), {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: passthrough ? 'error' : 'follow',
      headers: { 'accept-encoding': 'identity' },
    });
  } catch (e) {
    // Not rethrown as is: an invalid-URL error message carries the URL.
    throw new Error(`edge fallback request failed (${(e as Error)?.name ?? 'unknown'})`);
  }
  if (response.status >= 500 || TRANSIENT_CLIENT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`edge fallback failed: ${response.status}`);
  }
  // Only "not found" means absent; any other refusal may pass, so the caller retries.
  if (!response.ok && !ABSENT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`edge fallback failed: ${response.status}`);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return missing(`edge ${response.status}`);
  }
  const type = response.headers.get('content-type');
  if (type && !/^(image|video|audio)\//i.test(type.trim())) {
    await response.body.cancel().catch(() => undefined);
    return missing('edge copy is not media');
  }
  // Identity is asked for, but fetch decodes a compressed body anyway, so its declared length is not
  // what it holds.
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  const declared =
    encoding && encoding !== 'identity'
      ? UNKNOWN_SIZE
      : declaredLength(response.headers.get('content-length'));
  if (declared > MAX_ORIGINAL_IMAGE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    return missing(OVER_CAP);
  }
  return { response, body: response.body, declared };
}

type Reserve = (bytes: number) => Promise<() => void>;
const noReservation = () => undefined;

/** A reservation failure is the caller's (a failed archive), never storage's: it is not retried or reworded. */
class ReservationError extends Error {
  constructor(readonly reason: unknown) {
    super('reservation refused');
  }
}

async function reserveOrFail(reserve: Reserve, bytes: number) {
  try {
    return await reserve(bytes);
  } catch (e) {
    throw new ReservationError(e);
  }
}

/**
 * One attempt at the stored object. `undefined` means the object does not exist.
 *
 * With `reserve`, the object's size is taken from a HEAD and reserved BEFORE the GET is issued, so
 * no response sits on an open socket, headers received and body unread, while the reservation
 * waits its turn behind larger objects; storage drops such an idle connection. A HEAD that finds
 * nothing (or no length) leaves the reservation to after the GET's headers, as before.
 */
async function readStoredObjectOnce(
  image: ImageInput,
  { s3, bucket }: ImageBackend,
  reserve: Reserve | undefined,
  seen: { contentLength?: number }
): Promise<OriginalImageRead | undefined> {
  let release: () => void = noReservation;
  let reserved: number | undefined;
  let body: unknown;
  try {
    if (reserve) {
      let headLength: number | undefined;
      try {
        const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: image.url }), {
          abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        headLength = head.ContentLength;
      } catch (e) {
        // `NotFound` is also a wrong bucket; the GET below tells the two apart.
        if (!isMissingHead(e)) throw e;
      }
      if (headLength !== undefined) {
        seen.contentLength = headLength;
        if (headLength > MAX_ORIGINAL_IMAGE_BYTES) return missing(OVER_CAP);
        release = await reserveOrFail(reserve, headLength);
        reserved = headLength;
      }
    }

    const response = await s3
      .send(new GetObjectCommand({ Bucket: bucket, Key: image.url }), {
        abortSignal: AbortSignal.timeout(ORIGINAL_IMAGE_READ_TIMEOUT_MS),
      })
      .catch((e: unknown) => {
        if (isMissingObject(e)) return undefined;
        throw e;
      });
    if (!response) {
      release();
      return undefined;
    }

    body = response.Body;
    if (response.ContentLength !== undefined) seen.contentLength = response.ContentLength;
    if (!response.Body) throw new Error('original image response has no body');
    if ((response.ContentLength ?? 0) > MAX_ORIGINAL_IMAGE_BYTES) {
      destroyBody(body);
      release();
      return missing(OVER_CAP);
    }
    const length = response.ContentLength ?? UNKNOWN_SIZE;
    // No HEAD length, or the object grew since: reserve what the GET says it holds.
    if (reserve && (reserved === undefined || length > reserved)) {
      release();
      release = await reserveOrFail(reserve, length);
    }
    const bytes = await response.Body.transformToByteArray();
    // A view, not a copy: the object is held once.
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      source: 'original',
      data,
      contentType: pickContentType(response.ContentType, image.mimeType),
      sha256: createHash('sha256').update(data).digest('hex'),
      release,
    };
  } catch (e) {
    // An unread body holds its socket until the read timeout.
    if (body) destroyBody(body);
    release();
    throw e;
  }
}

/**
 * Names the object that failed (by image id and backend label; the key and bucket stay out of logs),
 * keeping the storage error's own message, name and code.
 */
function describeReadFailure(
  e: unknown,
  image: ImageInput,
  backend: string | undefined,
  contentLength: number | undefined,
  attempt: number,
  attempts: number
) {
  const cause = e as { message?: unknown; name?: unknown; code?: unknown; $metadata?: unknown };
  const message = typeof cause?.message === 'string' ? cause.message : String(e);
  const wrapped = new Error(
    `stored original read failed for image ${image.id ?? 'unknown'} ` +
      `(backend ${backend ?? 'unknown'}, ContentLength ${contentLength ?? 'unknown'}, ` +
      `attempt ${attempt}/${attempts}): ${message}`,
    { cause: e }
  );
  return Object.assign(wrapped, {
    ...(typeof cause?.name === 'string' && { name: cause.name }),
    ...(cause?.code !== undefined && { code: cause.code }),
    ...(cause?.$metadata !== undefined && { $metadata: cause.$metadata }),
  });
}

/**
 * The stored object under `Image.url`. Only a missing object falls back to the edge copy, so a
 * transient storage error cannot quietly downgrade evidence to an edge copy: a dropped connection
 * is retried with a fresh request, and any failure that remains throws so the caller retries.
 *
 * `reserve` takes the object's size before its body is read, so a caller can bound bytes held at
 * once. A failed attempt gives its reservation back before waiting to retry.
 */
export async function readOriginalImage(
  image: ImageInput,
  {
    reserve,
    backend,
    fetchImpl = fetch,
    attempts = ORIGINAL_IMAGE_READ_ATTEMPTS,
    sleep = defaultSleep,
  }: ReadOptions & {
    reserve?: Reserve;
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<OriginalImageRead> {
  const passthrough = isEdgeUrlPassthrough(image.url);

  if (!passthrough) {
    const storage = backend ?? (await getImageUploadBackend());
    let stored: OriginalImageRead | undefined;
    for (let attempt = 1; ; attempt++) {
      const seen: { contentLength?: number } = {};
      try {
        stored = await readStoredObjectOnce(image, storage, reserve, seen);
        break;
      } catch (e) {
        if (e instanceof ReservationError) throw e.reason;
        if (attempt < attempts && isDroppedConnection(e)) {
          await sleep(
            ORIGINAL_IMAGE_RETRY_DELAYS_MS[
              Math.min(attempt - 1, ORIGINAL_IMAGE_RETRY_DELAYS_MS.length - 1)
            ]
          );
          continue;
        }
        throw describeReadFailure(e, image, storage.backend, seen.contentLength, attempt, attempts);
      }
    }
    if (stored) return stored;
  }

  const refused = edgeRefusal(image.url, passthrough);
  if (refused) return refused;
  const edge = await fetchEdge(image, passthrough, fetchImpl, ORIGINAL_IMAGE_READ_TIMEOUT_MS);
  if ('source' in edge) return edge;
  const { response, body, declared } = edge;
  let release: () => void = noReservation;
  try {
    if (reserve) release = await reserve(declared);
    const data = await readCapped(body as unknown as AsyncIterable<Uint8Array>);
    return {
      source: 'edge-fallback',
      data,
      contentType: pickContentType(response.headers.get('content-type'), image.mimeType),
      sha256: createHash('sha256').update(data).digest('hex'),
      release,
    };
  } catch (e) {
    await body.cancel().catch(() => undefined);
    release();
    if (e instanceof OverCapError) return missing(OVER_CAP);
    throw e;
  }
}

/**
 * A storage HEAD, or the edge's headers with the body released, so a caller can decide before
 * reading. Throws what the read throws, except a wrong bucket (a HEAD says only `NotFound`) and a
 * body that fails mid-read.
 */
export async function probeOriginalImage(
  image: ImageInput,
  { backend, fetchImpl = fetch }: ReadOptions = {}
): Promise<{ source: 'original' | 'edge-fallback' } | MissingImage> {
  const passthrough = isEdgeUrlPassthrough(image.url);

  if (!passthrough) {
    const { s3, bucket } = backend ?? (await getImageUploadBackend());
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: image.url }), {
        abortSignal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if ((head.ContentLength ?? 0) > MAX_ORIGINAL_IMAGE_BYTES) return missing(OVER_CAP);
      return { source: 'original' };
    } catch (e) {
      if (!isMissingHead(e)) throw e;
    }
  }

  const refused = edgeRefusal(image.url, passthrough);
  if (refused) return refused;
  const edge = await fetchEdge(image, passthrough, fetchImpl, PROBE_TIMEOUT_MS);
  if ('source' in edge) return edge;
  await edge.body.cancel().catch(() => undefined);
  return { source: 'edge-fallback' };
}
