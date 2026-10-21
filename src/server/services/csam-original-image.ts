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

/**
 * The stored object under `Image.url`. Only a missing object falls back to the edge copy, so a
 * transient storage error cannot quietly downgrade evidence to an edge copy; it throws and the
 * caller retries.
 *
 * `reserve` takes the object's size before its body is read, so a caller can bound bytes held at once.
 */
export async function readOriginalImage(
  image: ImageInput,
  {
    reserve,
    backend,
    fetchImpl = fetch,
  }: ReadOptions & { reserve?: (bytes: number) => Promise<() => void> } = {}
): Promise<OriginalImageRead> {
  const noReservation = () => undefined;
  const passthrough = isEdgeUrlPassthrough(image.url);

  if (!passthrough) {
    const { s3, bucket } = backend ?? (await getImageUploadBackend());
    let response;
    try {
      response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: image.url }), {
        abortSignal: AbortSignal.timeout(ORIGINAL_IMAGE_READ_TIMEOUT_MS),
      });
    } catch (e) {
      if (!isMissingObject(e)) throw e;
    }

    if (response) {
      const body = response.Body;
      if (!body) throw new Error('original image response has no body');
      if ((response.ContentLength ?? 0) > MAX_ORIGINAL_IMAGE_BYTES) {
        destroyBody(body);
        return missing(OVER_CAP);
      }
      let release: () => void = noReservation;
      try {
        if (reserve) release = await reserve(response.ContentLength ?? UNKNOWN_SIZE);
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
