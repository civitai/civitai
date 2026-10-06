import type { Blob as OrchestratorBlob, ConsumerBlobPresignResponse } from '@civitai/client';
import { reportApplicationError } from '~/utils/application-error';
import type { UploadPartError } from '~/utils/upload-retry';
import {
  createPartStallWatchdog,
  describePartFailure,
  PART_RESPONSE_TIMEOUT_MS,
  shouldRetryPartError,
} from '~/utils/upload-retry';

export type UploadConsumerBlobResponse = OrchestratorBlob;

const MAX_UPLOAD_SIZE = 64 * 1024 * 1024; // 64MB
const SUPPORTED_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
] as const;
const PRESIGN_TIMEOUT_MS = 15_000;
// Each attempt fetches a fresh presigned URL: nothing says the previous one is reusable.
const MAX_ATTEMPTS = 2;

type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];

/** `kind` is built only from fixed strings and integer statuses, so it is safe to log as-is. */
export class ConsumerBlobUploadError extends Error {
  constructor(message: string, readonly kind: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ConsumerBlobUploadError';
  }
}

/**
 * Fetches a presigned URL for uploading a blob to the orchestrator.
 * The returned URL points to POST /v2/consumer/blobs with a signature for authentication.
 */
export async function getConsumerBlobUploadUrl(): Promise<ConsumerBlobPresignResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PRESIGN_TIMEOUT_MS);
  try {
    const response = await fetch('/api/orchestrator/getConsumerBlobUploadUrl', {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ConsumerBlobUploadError(
        response.status === 403 ? await response.text() : 'Failed to get upload URL',
        `presign-http-${response.status}`,
        false
      );
    }
    return await response.json();
  } catch (e) {
    if (e instanceof ConsumerBlobUploadError) throw e;
    if (controller.signal.aborted)
      throw new ConsumerBlobUploadError(
        'Timed out preparing the upload. Please try again.',
        'presign-timeout',
        true
      );
    throw new ConsumerBlobUploadError(
      'Could not reach the server to start the upload. Check your connection and try again.',
      'presign-network-error',
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

function toUploadError(err: UploadPartError, responseText: string) {
  const reason = describePartFailure(err);
  const kind = reason?.kind === 'part-status' ? `http-${reason.status}` : reason?.kind ?? 'unknown';
  const message = err.stalled
    ? 'Upload stalled. Check your connection and try again.'
    : err.networkError
    ? 'Upload failed. Check your connection and try again.'
    : `Failed to upload blob: ${responseText || err.status}`;
  return new ConsumerBlobUploadError(message, kind, shouldRetryPartError(err));
}

function postBlob(uploadUrl: string, data: Blob, contentType: string) {
  return new Promise<UploadConsumerBlobResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let bodySent = false;
    let responsePhase = false;
    const watchdog = createPartStallWatchdog(() => {
      stalled = true;
      responsePhase = bodySent;
      xhr.abort();
    });
    xhr.upload.addEventListener('progress', () => watchdog.arm());
    xhr.upload.addEventListener('load', () => {
      bodySent = true;
      watchdog.arm(PART_RESPONSE_TIMEOUT_MS);
    });
    xhr.addEventListener('loadend', () => {
      watchdog.clear();
      if (stalled)
        return reject(
          toUploadError({ status: null, networkError: true, stalled: true, responsePhase }, '')
        );
      if (xhr.status === 0) return reject(toUploadError({ status: null, networkError: true }, ''));
      if (xhr.status < 200 || xhr.status >= 300)
        return reject(
          toUploadError(
            { status: xhr.status, retryAfter: xhr.getResponseHeader('Retry-After') },
            xhr.responseText || xhr.statusText
          )
        );
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        reject(new ConsumerBlobUploadError('Invalid upload response', 'invalid-response', false));
      }
    });
    try {
      xhr.open('POST', uploadUrl);
      xhr.setRequestHeader('Content-Type', contentType);
      watchdog.arm();
      xhr.send(data);
    } catch (e) {
      watchdog.clear();
      reject(e);
    }
  });
}

/**
 * Uploads a blob/file to the orchestrator using a presigned URL, directly from the browser.
 * A stalled or dropped upload is aborted and retried once before the error is thrown.
 *
 * @throws Error if file exceeds 64MB, has unsupported content type, or the upload fails
 */
export async function uploadConsumerBlob(data: Blob | File): Promise<UploadConsumerBlobResponse> {
  if (data.size > MAX_UPLOAD_SIZE) {
    throw new Error(`File size exceeds maximum of 64MB`);
  }

  const contentType = data.type as SupportedContentType;
  if (!SUPPORTED_CONTENT_TYPES.includes(contentType)) {
    throw new Error(
      `Unsupported content type: ${
        data.type || 'unknown'
      }. Supported types: ${SUPPORTED_CONTENT_TYPES.join(', ')}`
    );
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const { uploadUrl } = await getConsumerBlobUploadUrl();
      return await postBlob(uploadUrl, data, contentType);
    } catch (e) {
      if (!(e instanceof ConsumerBlobUploadError)) throw e;
      // A fresh Error so only the bounded `kind` is logged, never server-supplied response text.
      void reportApplicationError(new Error(`consumer blob upload failed: ${e.kind}`), {
        name: 'consumer-blob-upload',
        message: `attempt ${attempt}/${MAX_ATTEMPTS}`,
        resolveStack: false,
      });
      if (!e.retryable || attempt >= MAX_ATTEMPTS) throw e;
    }
  }
}
