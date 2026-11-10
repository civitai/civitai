import { createHash, randomUUID } from 'crypto';
import { rmSync } from 'fs';
import { mkdir, open } from 'fs/promises';
import { join } from 'path';
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

/** A large stored original, spooled to a file. `release` deletes the file and returns the reservation. */
export type SpooledImage = {
  source: 'original';
  path: string;
  bytes: number;
  contentType: string;
  sha256: string;
  release: () => void;
};

export type MissingImage = { source: 'missing'; reason: string };

export type OriginalImageRead = OriginalImage | MissingImage;

type ImageInput = { url: string; type: MediaType; mimeType?: string | null };
type ImageBackend = { s3: S3Client; bucket: string };
type ReadOptions = { backend?: ImageBackend; fetchImpl?: typeof fetch };

/** Long enough for a maximum-size original. */
export const ORIGINAL_IMAGE_READ_TIMEOUT_MS = 10 * 60 * 1000;

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
  timeoutMs: number,
  cancel?: AbortSignal
) {
  let response: Response;
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    // A stored full URL is fetched as is, so it must not redirect somewhere we did not vet.
    response = await fetchImpl(getEdgeUrl(image.url, { type: image.type }), {
      signal: cancel ? AbortSignal.any([cancel, timeout]) : timeout,
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

const STORED_READ_ATTEMPTS = 3;
const STORED_READ_RETRY_DELAY_MS = 250;

/** A stored object larger than this is read in ranged parts into a spool file, when a caller spools. */
export const SPOOL_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const RANGE_PART_BYTES = 16 * 1024 * 1024;

const SOCKET_FAILURE_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT']);
const isSocketFailure = (e: unknown) =>
  SOCKET_FAILURE_CODES.has((e as { code?: unknown } | undefined)?.code as string);

type Reserve = (bytes: number) => Promise<() => void>;
type OnRetry = (failedAttempt: number) => void;
const noReservation = () => undefined;

/**
 * Retries a socket failure with a fresh request, never a resume. Each attempt gets the read timeout,
 * cut short by `deadline` if given.
 */
async function withSocketRetry<T>(
  read: (signal: AbortSignal) => Promise<T>,
  onRetry?: OnRetry,
  deadline?: AbortSignal
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(ORIGINAL_IMAGE_READ_TIMEOUT_MS);
    const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout;
    try {
      return await read(signal);
    } catch (e) {
      // A timeout surfaces as the same reset, after the whole window: not retried.
      if (signal.aborted || attempt >= STORED_READ_ATTEMPTS || !isSocketFailure(e)) throw e;
      onRetry?.(attempt);
      await new Promise((resolve) => setTimeout(resolve, STORED_READ_RETRY_DELAY_MS * attempt));
    }
  }
}

type LargeStoredObject = {
  large: true;
  size: number;
  etag: string;
  contentType: string;
  spoolDir: string;
};

/** `undefined` when no object is stored under the key. */
async function readStoredObject(
  { s3, bucket }: ImageBackend,
  image: ImageInput,
  reserve: Reserve | undefined,
  spoolDir: string | undefined,
  abortSignal: AbortSignal
): Promise<OriginalImageRead | LargeStoredObject | undefined> {
  let response;
  try {
    response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: image.url }), {
      abortSignal,
    });
  } catch (e) {
    if (isMissingObject(e)) return undefined;
    throw e;
  }

  const body = response.Body;
  if (!body) throw new Error('original image response has no body');
  const size = response.ContentLength;
  if ((size ?? 0) > MAX_ORIGINAL_IMAGE_BYTES) {
    destroyBody(body);
    return missing(OVER_CAP);
  }
  if (spoolDir && size !== undefined && size > SPOOL_THRESHOLD_BYTES) {
    destroyBody(body);
    if (!response.ETag) throw new Error('original image response has no ETag');
    const contentType = pickContentType(response.ContentType, image.mimeType);
    return { large: true, size, etag: response.ETag, contentType, spoolDir };
  }
  let release: () => void = noReservation;
  try {
    if (reserve) release = await reserve(size ?? UNKNOWN_SIZE);
    const bytes = await body.transformToByteArray();
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
    destroyBody(body);
    release();
    throw e;
  }
}

/** One part, from the version the first response named: a changed object fails, never mixes. */
async function readRange(
  { s3, bucket }: ImageBackend,
  key: string,
  { etag, size }: LargeStoredObject,
  start: number,
  end: number,
  abortSignal: AbortSignal
) {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      Range: `bytes=${start}-${end}`,
      IfMatch: etag,
    }),
    { abortSignal }
  );
  const body = response.Body;
  if (!body) throw new Error('original image part has no body');
  try {
    if (response.ContentRange !== `bytes ${start}-${end}/${size}`)
      throw new Error('original image part has the wrong range');
    // Checked here too, so a store that ignores If-Match still cannot mix two versions.
    if (response.ETag !== etag) throw new Error('original image part is from another version');
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  } catch (e) {
    destroyBody(body);
    throw e;
  }
}

/**
 * Reads a large stored object in ranged parts into a file, so a connection cut partway through
 * costs one part, not the whole object. The file is complete and its length checked against the
 * object's before it is returned; on any failure it is removed.
 */
async function spoolStoredObject(
  storage: ImageBackend,
  image: ImageInput,
  large: LargeStoredObject,
  reserve: Reserve | undefined,
  onRetry: OnRetry | undefined,
  cancel: AbortSignal | undefined
): Promise<SpooledImage> {
  const releaseReservation = reserve ? await reserve(large.size) : noReservation;
  let path: string | undefined;
  try {
    await mkdir(large.spoolDir, { recursive: true });
    path = join(large.spoolDir, `${randomUUID()}.part`);
    const hash = createHash('sha256');
    // The whole object gets the window one whole-object read had.
    const timeout = AbortSignal.timeout(ORIGINAL_IMAGE_READ_TIMEOUT_MS);
    const deadline = cancel ? AbortSignal.any([cancel, timeout]) : timeout;
    let written = 0;
    const file = await open(path, 'wx');
    try {
      for (let start = 0; start < large.size; start += RANGE_PART_BYTES) {
        // A storage client may finish a part it was asked to abort; the next part is never started.
        cancel?.throwIfAborted();
        const end = Math.min(start + RANGE_PART_BYTES, large.size) - 1;
        const part = await withSocketRetry(
          (signal) => readRange(storage, image.url, large, start, end, signal),
          onRetry,
          deadline
        );
        hash.update(part);
        // A write can return having written less, with no error (a full disk does).
        for (let offset = 0; offset < part.length; ) {
          const { bytesWritten } = await file.write(part, offset, part.length - offset);
          if (bytesWritten === 0) throw new Error('spooled original image write made no progress');
          offset += bytesWritten;
          written += bytesWritten;
        }
      }
    } finally {
      await file.close();
    }
    if (written !== large.size) throw new Error('spooled original image has the wrong size');

    const spooled = path;
    let released = false;
    return {
      source: 'original',
      path: spooled,
      bytes: large.size,
      contentType: large.contentType,
      sha256: hash.digest('hex'),
      release: () => {
        if (released) return;
        released = true;
        rmSync(spooled, { force: true });
        releaseReservation();
      },
    };
  } catch (e) {
    if (path) rmSync(path, { force: true });
    releaseReservation();
    throw e;
  }
}

type ReadOriginalOptions = ReadOptions & {
  reserve?: Reserve;
  /** Called before each retry with the attempt that failed. */
  onRetry?: OnRetry;
  /** Aborting it stops the read at its next request: the caller no longer wants the bytes. */
  cancel?: AbortSignal;
};

function readOriginal(image: ImageInput, options: ReadOriginalOptions): Promise<OriginalImageRead>;
function readOriginal(
  image: ImageInput,
  options: ReadOriginalOptions,
  spoolDir: string
): Promise<OriginalImageRead | SpooledImage>;
async function readOriginal(
  image: ImageInput,
  { reserve, backend, fetchImpl = fetch, onRetry, cancel }: ReadOriginalOptions,
  spoolDir?: string
): Promise<OriginalImageRead | SpooledImage> {
  const passthrough = isEdgeUrlPassthrough(image.url);

  if (!passthrough) {
    const storage = backend ?? (await getImageUploadBackend());
    const stored = await withSocketRetry(
      (signal) => readStoredObject(storage, image, reserve, spoolDir, signal),
      onRetry,
      cancel
    );
    if (stored && 'large' in stored)
      return spoolStoredObject(storage, image, stored, reserve, onRetry, cancel);
    if (stored) return stored;
  }

  const refused = edgeRefusal(image.url, passthrough);
  if (refused) return refused;
  const edge = await fetchEdge(
    image,
    passthrough,
    fetchImpl,
    ORIGINAL_IMAGE_READ_TIMEOUT_MS,
    cancel
  );
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
 * The stored object under `Image.url`, in memory. Only a missing object falls back to the edge copy,
 * so a transient storage error cannot quietly downgrade evidence to an edge copy. A socket failure
 * is retried with a fresh request, never a resume, up to `STORED_READ_ATTEMPTS`; any other error
 * throws and the caller retries.
 *
 * `reserve` takes the object's size before its body is read, so a caller can bound bytes held at once.
 * The whole object is read before it is returned, so a failed attempt hands the caller no bytes.
 */
export function readOriginalImage(image: ImageInput, options: ReadOriginalOptions = {}) {
  return readOriginal(image, options);
}

/**
 * As {@link readOriginalImage}, except a stored object over `SPOOL_THRESHOLD_BYTES` is read in
 * ranged parts into a file under `spoolDir`, each part retried on its own. The caller must call
 * `release`, which deletes the file.
 */
export function spoolOriginalImage(
  image: ImageInput,
  { spoolDir, ...options }: ReadOriginalOptions & { spoolDir: string }
) {
  return readOriginal(image, options, spoolDir);
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
