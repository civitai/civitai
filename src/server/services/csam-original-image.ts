import { createHash } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getEdgeUrl } from '~/client-utils/edge-url';
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

const OCTET_STREAM = 'application/octet-stream';

function isMissingObject(e: unknown) {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;
}

function pickContentType(...candidates: (string | null | undefined)[]) {
  for (const candidate of candidates) {
    const type = candidate?.split(';')[0].trim().toLowerCase();
    if (type && type !== OCTET_STREAM) return type;
  }
  return OCTET_STREAM;
}

/** Zip entry extension from a content type; never from a user-supplied file name. */
export function extensionForContentType(contentType: string) {
  const subtype = contentType.split('/')[1] ?? '';
  return /^[a-z0-9][a-z0-9.+-]{0,15}$/.test(subtype) && contentType !== OCTET_STREAM
    ? subtype
    : 'bin';
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

  if (!/^https?:\/\//i.test(image.url)) {
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
      if (!response.Body) throw new Error('original image response has no body');
      const release = reserve ? await reserve(response.ContentLength ?? 0) : noReservation;
      try {
        const data = Buffer.from(await response.Body.transformToByteArray());
        return {
          source: 'original',
          data,
          contentType: pickContentType(response.ContentType, image.mimeType),
          sha256: createHash('sha256').update(data).digest('hex'),
          release,
        };
      } catch (e) {
        release();
        throw e;
      }
    }
  }

  // No width: the edge's own original, the copy the NCMEC upload used before originals were read.
  const response = await fetchImpl(getEdgeUrl(image.url, { type: image.type }), {
    signal: AbortSignal.timeout(ORIGINAL_IMAGE_READ_TIMEOUT_MS),
    credentials: 'omit',
  });
  if (response.status >= 500) throw new Error(`edge fallback failed: ${response.status}`);
  if (!response.ok) return { source: 'missing' };

  const data = Buffer.from(await response.arrayBuffer());
  const release = reserve ? await reserve(data.length) : noReservation;
  return {
    source: 'edge-fallback',
    data,
    contentType: pickContentType(response.headers.get('content-type'), image.mimeType),
    sha256: createHash('sha256').update(data).digest('hex'),
    release,
  };
}
