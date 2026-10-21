import { createHash } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getEdgeUrl } from '~/client-utils/edge-url';
import { isAllowedImageScanUrl } from '~/server/utils/image-scan-url';
import { isEdgeUrlPassthrough } from '~/shared/utils/edge-url-passthrough';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { getImageUploadBackend } from '~/utils/s3-utils';

/**
 * Reads the bytes a user uploaded, for CSAM evidence (the report archive and the NCMEC upload).
 *
 * 🔴 IMPORT-GUARDED: `no-csam-original-image-import.test.ts` fails if anything outside those two
 * paths imports this module. It bypasses every delivery-side control (edge, NSFW level,
 * moderation), so it must not become a general "serve the original" helper.
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

export type OriginalImageRead = OriginalImage | { source: 'missing' };

type ImageBackend = { s3: S3Client; bucket: string };

/** Long enough for a maximum-size video original over the internal network. */
export const ORIGINAL_IMAGE_READ_TIMEOUT_MS = 10 * 60 * 1000;

/** Above any upload limit; an edge response larger than this is not an image we stored. */
export const MAX_EDGE_FALLBACK_BYTES = 1024 * 1024 * 1024;

const OCTET_STREAM = 'application/octet-stream';

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

/** Edge statuses that say "try again", not "this does not exist". */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

// Only NoSuchKey: a plain 404 is also what a wrong bucket returns, and that must not quietly turn
// every original into an edge copy.
const isMissingObject = (e: unknown) => (e as { name?: string } | undefined)?.name === 'NoSuchKey';

function pickContentType(...candidates: (string | null | undefined)[]) {
  for (const candidate of candidates) {
    const type = candidate?.split(';')[0].trim().toLowerCase();
    if (type && type !== OCTET_STREAM && /^[a-z]+\/[a-z0-9.+-]{1,64}$/.test(type)) return type;
  }
  return OCTET_STREAM;
}

/** Zip entry extension from a content type; never from a user-supplied file name. */
export function extensionForContentType(contentType: string) {
  return MEDIA_EXTENSIONS[contentType] ?? 'bin';
}

const destroyBody = (body: unknown) => (body as { destroy?: () => void }).destroy?.();

async function readCapped(body: AsyncIterable<Uint8Array>, capBytes: number) {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > capBytes) throw new Error('edge fallback response exceeds the size cap');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The stored object under `Image.url`, falling back to the uncapped edge copy only when the
 * object does not exist. Any other storage error throws, so a transient failure can never
 * quietly downgrade evidence to an edge copy; the caller retries.
 *
 * `reserve` is called with the object's size before its body is read, so a caller can bound how
 * many bytes are held at once.
 */
export async function readOriginalImage(
  image: { url: string; type: MediaType; mimeType?: string | null },
  {
    reserve,
    backend,
    fetchImpl = fetch,
  }: {
    reserve?: (bytes: number) => Promise<() => void>;
    backend?: ImageBackend;
    fetchImpl?: typeof fetch;
  } = {}
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
      let release: () => void = noReservation;
      try {
        if (reserve) release = await reserve(response.ContentLength ?? 0);
        const data = Buffer.from(await body.transformToByteArray());
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
  } else if (!isAllowedImageScanUrl(image.url)) {
    return { source: 'missing' };
  }

  let response: Response;
  try {
    // No width: the edge's own original, the copy the NCMEC upload used before originals were
    // read. A stored full URL is fetched as is, so it may not redirect somewhere we did not vet.
    response = await fetchImpl(getEdgeUrl(image.url, { type: image.type }), {
      signal: AbortSignal.timeout(ORIGINAL_IMAGE_READ_TIMEOUT_MS),
      redirect: passthrough ? 'error' : 'follow',
    });
  } catch (e) {
    // Not rethrown as is: an invalid-URL error message carries the URL.
    throw new Error(`edge fallback request failed (${(e as Error)?.name ?? 'unknown'})`);
  }
  if (response.status >= 500 || TRANSIENT_CLIENT_STATUSES.has(response.status))
    throw new Error(`edge fallback failed: ${response.status}`);
  if (!response.ok || !response.body) return { source: 'missing' };

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_EDGE_FALLBACK_BYTES) {
    await response.body.cancel();
    throw new Error('edge fallback response exceeds the size cap');
  }
  const body = response.body;
  let release: () => void = noReservation;
  try {
    if (reserve) release = await reserve(declared);
    const data = await readCapped(
      body as unknown as AsyncIterable<Uint8Array>,
      MAX_EDGE_FALLBACK_BYTES
    );
    return {
      source: 'edge-fallback',
      data,
      contentType: pickContentType(response.headers.get('content-type'), image.mimeType),
      sha256: createHash('sha256').update(data).digest('hex'),
      release,
    };
  } catch (e) {
    // Rejects harmlessly when the read loop has already released the stream.
    await body.cancel().catch(() => undefined);
    release();
    throw e;
  }
}
