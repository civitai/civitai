import type { Blob as OrchestratorBlob, ConsumerBlobPresignResponse } from '@civitai/client';
import { reportApplicationError } from '~/utils/application-error';
import type { UploadPartError } from '~/utils/upload-retry';
import {
  createPartStallWatchdog,
  describePartFailure,
  getPartRetryDelay,
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
// Silence allowed after the body is sent. Long because the orchestrator processes the media inside
// the POST and cancels that work when the client aborts, so a short window kills uploads it is
// still processing.
const RESPONSE_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPTS = 2;
// Waits between presign retries on a 5xx, network error or timeout. An orchestrator restart
// once made presign fail for ~32 s, longer than the single ~1–2 s retry could cover. With
// fast failures the last try starts ~40 s in, past an outage of that length. Up to 1 s of
// jitter is added to each wait so clients that failed together do not retry together.
const PRESIGN_RETRY_DELAYS_MS = [2_000, 6_000, 12_000, 20_000];
// No new presign try may start later than this after the first one. Matters only when tries
// end in the 15 s timeout: without it, five timed-out tries plus the waits would take ~2 min.
const PRESIGN_RETRY_BUDGET_MS = 50_000;

/** Shown when an upload is refused because the user is signed out. */
export const SIGN_IN_TO_UPLOAD_MESSAGE = 'Sign in to upload images.';

type SupportedContentType = (typeof SUPPORTED_CONTENT_TYPES)[number];

/** `kind` is built only from fixed strings and integer statuses, so it is safe to log as-is. */
export class ConsumerBlobUploadError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean,
    readonly failure?: UploadPartError
  ) {
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
  // The watchdog rather than a bare timer so time in a backgrounded tab does not count.
  const watchdog = createPartStallWatchdog(() => controller.abort());
  watchdog.arm(PRESIGN_TIMEOUT_MS);
  try {
    const response = await fetch('/api/orchestrator/getConsumerBlobUploadUrl', {
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = { status: response.status, retryAfter: response.headers.get('Retry-After') };
      throw new ConsumerBlobUploadError(
        response.status === 400 || response.status === 403
          ? await response.text()
          : response.status === 401
          ? SIGN_IN_TO_UPLOAD_MESSAGE
          : 'Failed to get upload URL',
        `presign-http-${response.status}`,
        shouldRetryPartError(failure),
        failure
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
    watchdog.clear();
  }
}

/**
 * Presigns, retrying a 5xx, network error or timeout on `PRESIGN_RETRY_DELAYS_MS` within
 * `PRESIGN_RETRY_BUDGET_MS`, and throws the last error once it gives up. A 429 is thrown
 * at once, so the caller's Retry-After handling stays as it was. A 400/401/403 is not
 * retryable and is also thrown at once. A Retry-After on a 5xx is not read: the presign
 * route never sends one, so the schedule applies.
 *
 * There is no abort signal to honour: `uploadConsumerBlob` takes none.
 */
async function getConsumerBlobUploadUrlWithRetry() {
  const startedAt = Date.now();
  for (let retry = 0; ; retry++) {
    try {
      return await getConsumerBlobUploadUrl();
    } catch (e) {
      if (!(e instanceof ConsumerBlobUploadError) || !e.retryable || e.failure?.status === 429)
        throw e;
      const delay = PRESIGN_RETRY_DELAYS_MS[retry];
      if (delay === undefined) throw e;
      const wait = delay + Math.random() * 1000;
      if (Date.now() - startedAt + wait > PRESIGN_RETRY_BUDGET_MS) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

function toUploadError(err: UploadPartError, responseText: string) {
  const reason = describePartFailure(err);
  const kind = reason?.kind === 'part-status' ? `http-${reason.status}` : reason?.kind ?? 'unknown';
  const message = err.responsePhase
    ? 'Timed out waiting for the server to process the upload. Please try again.'
    : err.stalled
    ? 'Upload stalled. Check your connection and try again.'
    : err.networkError
    ? 'Upload failed. Check your connection and try again.'
    : `Failed to upload blob: ${responseText || err.status}`;
  // Not after a response-phase stall: a retry would restart the server's processing from zero.
  const retryable = shouldRetryPartError(err) && !err.responsePhase;
  return new ConsumerBlobUploadError(message, kind, retryable, err);
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
      watchdog.arm(RESPONSE_TIMEOUT_MS);
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
 * The upload is retried once, with a fresh presigned URL, on a network error, 429, 5xx or a
 * stall before the body is fully sent. Presigning retries a 5xx, network error or timeout on
 * its own, for up to ~50 s (`getConsumerBlobUploadUrlWithRetry`). A presign 429 still gets
 * one retry after its Retry-After.
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
    let presigned = false;
    try {
      // Re-presigned per attempt: nothing says a used upload URL can be reused.
      const { uploadUrl } = await getConsumerBlobUploadUrlWithRetry();
      presigned = true;
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
      // A presign failure other than a 429 reaches here only after the presign retries ran
      // out, so one more attempt would only repeat them.
      if (!presigned && e.failure?.status !== 429) throw e;
      const delay = getPartRetryDelay(e.failure ?? { status: null }, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
