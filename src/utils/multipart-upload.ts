import type { UploadType, UploadTypeUnion } from '~/server/common/enums';
import { abortableSleep, withRetries } from '~/utils/errorHandling';
import type { ClientDeclarableRelayFallbackOutcome } from '~/utils/relay-fallback-outcome';
import type { PartFailureReason, UploadPartError } from '~/utils/upload-retry';
import {
  createPartStallWatchdog,
  getPartRetryDelay,
  isExpiredPartError,
  isTerminalCompleteStatus,
  MAX_PART_ATTEMPTS,
  shouldRetryPartError,
} from '~/utils/upload-retry';

const FILE_CHUNK_SIZE = 25 * 1024 * 1024; // 25 MB
const CONCURRENT_PARTS = 4;
// The VISIBLE-silence window once the body is fully sent, and wider than the body's because a
// server legitimately takes its time producing an ETag while no `upload.progress` re-arms it.
// Not a cap on the wait: `createPartStallWatchdog` re-arms across a hidden tab.
const PART_RESPONSE_TIMEOUT_MS = 5 * 60_000;

const completeEndpoint = '/api/upload/complete';
const abortEndpoint = '/api/upload/abort';
const signPartEndpoint = '/api/upload/sign-part';

type MultipartSession = {
  urls: Array<{ url: string; partNumber: number }>;
  bucket: string;
  key: string;
  uploadId?: string;
  backend?: string;
  chunkSize?: number;
};

export type MultipartRequestOptions = {
  endpoint?: { request: { body: MixedObject; headers: HeadersInit } };
};

export type UploadProgress = {
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
};

/**
 * Opens a multipart session for `file` and returns the steps that finish it. Throws when the session
 * cannot be opened: the server's `error` when the response carries one, otherwise whatever `fetch`
 * or `res.json()` threw (a non-JSON 403 page throws a `SyntaxError`).
 */
export async function startMultipartUpload({
  file,
  type,
  endpoint = '/api/upload',
  options,
}: {
  file: File;
  type: UploadType | UploadTypeUnion;
  endpoint?: string;
  options?: MultipartRequestOptions;
}) {
  const requestExtras = options?.endpoint?.request ?? { headers: {}, body: {} };
  const { size } = file;
  const headers = { ...requestExtras.headers, 'Content-Type': 'application/json' };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      filename: encodeURIComponent(file.name),
      type,
      size,
      mimeType: file.type,
      ...requestExtras.body,
    }),
  });

  const data = (await res.json()) as MultipartSession | { error: string };
  if ('error' in data) {
    console.error(data.error);
    throw data.error;
  }

  const { bucket, key, uploadId, urls, backend } = data;
  // The server sizes chunks against the file so the part count stays bounded; slicing by
  // anything else would send parts that don't match what it signed.
  const chunkSize = data.chunkSize ?? FILE_CHUNK_SIZE;
  const parts: { ETag: string; PartNumber: number }[] = [];

  // Swap an expired part URL for a fresh one. A file big enough to take longer than the presign
  // lifetime would otherwise die at the point where its remaining parts all start coming back 403.
  const resignPart = async (partNumber: number) => {
    if (!uploadId) return null;
    try {
      const res = await fetch(signPartEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ bucket, key, uploadId, partNumber, backend }),
      });
      if (!res.ok) return null;
      const signed = (await res.json()) as { url?: string };
      return signed.url ?? null;
    } catch {
      return null;
    }
  };

  /**
   * Sends every part, retrying the transient failures, and resolves with the failure that ended
   * the upload, or `null` once every part is stored.
   *
   * 🔴 `signal` is the PERSON's cancel and nothing else. On a fatal part failure the upload tears
   * itself down with its own controller and leaves `signal` alone, so `signal.aborted` afterwards
   * still says whether the person cancelled — which `resolveUploadRowStatus` and
   * `selectRelayFallback` both need.
   */
  async function transferParts({
    signal,
    onProgress,
  }: {
    signal: AbortSignal;
    onProgress: (progress: UploadProgress) => void;
  }): Promise<UploadPartError | null> {
    const activeXhrs = new Set<XMLHttpRequest>();
    const teardownController = new AbortController();
    const teardown = () => {
      teardownController.abort();
      for (const x of activeXhrs) x.abort();
    };
    signal.addEventListener('abort', teardown);
    if (signal.aborted) teardown();

    const uploadStart = Date.now();
    const partProgress = new Map<number, number>();
    const reportProgress = () => {
      let uploaded = 0;
      for (const v of partProgress.values()) uploaded += v;
      if (!uploaded) return;
      const secondsElapsed = (Date.now() - uploadStart) / 1000;
      const speed = uploaded / secondsElapsed;
      onProgress({
        progress: size ? (uploaded / size) * 100 : 0,
        uploaded,
        size,
        speed,
        timeRemaining: (size - uploaded) / speed,
      });
    };

    const partsCount = urls.length;
    const uploadPart = (url: string, i: number) =>
      new Promise<void>((resolve, reject) => {
        let eTag: string;
        const start = (i - 1) * chunkSize;
        const end = i * chunkSize;
        const part = i === partsCount ? file.slice(start) : file.slice(start, end);
        const xhr = new XMLHttpRequest();
        activeXhrs.add(xhr);
        // 🔴 `aborted: false` on a stall is deliberate: `selectRelayFallback` refuses `err.aborted`,
        // so a stall reported as an abort could never reach the relay.
        let stalled = false;
        let responsePhase = false;
        let bodySent = false;
        const rejectStalled = () =>
          reject({
            status: null,
            networkError: true,
            aborted: false,
            stalled: true,
            responsePhase,
            partNumber: i,
          } as UploadPartError);
        const watchdog = createPartStallWatchdog(() => {
          stalled = true;
          // 🔴 SAMPLED HERE, not when the rejection is built: `xhr.abort()` runs XHR's
          // request-error steps, which fire `upload.loadend` before the xhr-level `abort` while
          // the body is in flight, so reading it any later reports every mid-body stall as a
          // response-phase one.
          responsePhase = bodySent;
          xhr.abort();
        });
        xhr.upload.addEventListener('progress', ({ loaded }) => {
          watchdog.arm();
          partProgress.set(i, loaded);
          reportProgress();
        });
        xhr.upload.addEventListener('loadend', ({ loaded }) => {
          // The window WIDENS here rather than ending: what remains is a wait for a tiny ETag
          // reply, not a transfer, so the body's window would kill a slow-but-healthy server
          // while no window at all lets a connection that goes half-open AFTER the body hold a
          // worker slot for the life of the page.
          //
          // 🔴 REACHING HERE DOES NOT MEAN THE BODY GOT THROUGH: XHR's request-error steps fire
          // `upload.loadend` on `abort` and on `error` too. `bodySent`'s one reader is the
          // watchdog callback above, which samples it BEFORE `xhr.abort()` for that reason.
          //
          // 🔴 RE-ARM, NEVER `xhr.timeout` — a browser timer counts wall clock while the tab is
          // hidden, so bounding this phase with one costs a needlessly re-sent part.
          bodySent = true;
          watchdog.arm(PART_RESPONSE_TIMEOUT_MS);
          partProgress.set(i, loaded);
        });
        xhr.addEventListener('load', () => {
          eTag = xhr.getResponseHeader('ETag') ?? '';
        });
        xhr.addEventListener('loadend', () => {
          // The one clear: fires after load, error and abort alike.
          watchdog.clear();
          activeXhrs.delete(xhr);
          if (xhr.readyState !== 4) return;
          if (xhr.status === 200) {
            parts.push({ ETag: eTag, PartNumber: i });
            resolve();
          } else {
            // An HTTP failure fires neither 'error' nor 'abort'. Without this the promise never
            // settles, the worker parks forever, and the upload sits at ~100% with no error.
            reject({
              status: xhr.status,
              retryAfter: xhr.getResponseHeader('Retry-After'),
              partNumber: i,
            } as UploadPartError);
          }
        });
        xhr.addEventListener('error', () => {
          activeXhrs.delete(xhr);
          reject({ status: null, networkError: true, partNumber: i } as UploadPartError);
        });
        xhr.addEventListener('abort', () => {
          activeXhrs.delete(xhr);
          if (stalled) return rejectStalled();
          reject({ status: null, aborted: true, partNumber: i } as UploadPartError);
        });
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        watchdog.arm();
        xhr.send(part);
      });

    const queue = [...urls];
    let fatal: UploadPartError | null = null;

    const runWorker = async () => {
      while (queue.length > 0 && !fatal) {
        if (teardownController.signal.aborted) {
          fatal = { status: null, aborted: true };
          return;
        }
        const item = queue.shift();
        if (!item) return;

        let url = item.url;
        let partError: UploadPartError | null = null;
        for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
          if (teardownController.signal.aborted) {
            partError = { status: null, aborted: true };
            break;
          }
          try {
            await uploadPart(url, item.partNumber);
            partError = null;
            break;
          } catch (e) {
            partError = e as UploadPartError;
          }
          if (attempt === MAX_PART_ATTEMPTS - 1) break;
          if (isExpiredPartError(partError)) {
            const fresh = await resignPart(item.partNumber);
            if (!fresh) break;
            url = fresh;
            continue;
          }
          if (!shouldRetryPartError(partError)) break;
          await abortableSleep(getPartRetryDelay(partError, attempt), teardownController.signal);
        }

        if (partError) {
          // First failure wins so a real error doesn't get masked by a later abort.
          if (!fatal) fatal = partError;
          teardown();
          return;
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENT_PARTS, urls.length) }, () => runWorker())
      );
    } finally {
      signal.removeEventListener('abort', teardown);
    }
    return fatal;
  }

  /**
   * Finalizes the parts `transferParts` stored. Resolves `null` when the request itself kept
   * failing, so every caller lands on the same "not completed" branch as a non-ok response.
   */
  const complete = () => {
    // S3 requires parts ordered by PartNumber in CompleteMultipartUpload.
    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    return withRetries(
      async (remainingAttempts) => {
        const res = await fetch(completeEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({ bucket, key, type, uploadId, parts, backend }),
        });

        if (!res.ok && !isTerminalCompleteStatus(res.status) && remainingAttempts > 0)
          throw new Error(`Failed to complete upload (${res.status})`);

        return res;
      },
      3,
      1000
    ).catch((err) => {
      console.error('Failed to complete upload');
      console.error(err);
      return null;
    });
  };

  // Best-effort teardown of the server-side multipart session. EVERY give-up path after the session
  // opened must run this, or its stored parts accrue storage forever. Failures are logged, not
  // thrown, so they never replace the real cause of the give-up.
  const abort = async (
    failure?: PartFailureReason,
    relayOutcome?: ClientDeclarableRelayFallbackOutcome
  ) => {
    try {
      await fetch(abortEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          bucket,
          key,
          type,
          uploadId,
          backend,
          fileSize: size,
          ...(failure ? { failure } : {}),
          ...(relayOutcome ? { relayOutcome } : {}),
        }),
      });
    } catch (err) {
      console.error('Failed to abort upload');
      console.error(err);
    }
  };

  return {
    bucket,
    key,
    backend,
    /** The stored object's URL: the first part URL without its signature. */
    url: urls[0]?.url.split('?')[0] ?? '',
    transferParts,
    complete,
    abort,
  };
}
