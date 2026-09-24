import type { ChangeEvent, ReactElement } from 'react';
import React, { forwardRef, useRef, useState } from 'react';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { useFileUploadContext } from '~/components/FileUpload/FileUploadProvider';
import type { UploadTypeUnion } from '~/server/common/enums';
import { UploadType } from '~/server/common/enums';
import { withRetries } from '~/utils/errorHandling';
import type { PartFailureReason, UploadPartError } from '~/utils/upload-retry';
import {
  describePartFailure,
  getPartRetryDelay,
  isTerminalCompleteStatus,
  MAX_PART_ATTEMPTS,
  resolveTerminalUploadStatus,
  shouldRelayOnPartFailure,
  shouldRetryPartError,
} from '~/utils/upload-retry';
import { relayImageFallback } from '~/utils/upload-settlement';

const FILE_CHUNK_SIZE = 25 * 1024 * 1024; // 25 MB
const CONCURRENT_PARTS = 4;

// Abort-aware sleep so cancelling during a long Retry-After window
// short-circuits the backoff instead of waiting it out.
function cancellableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const onDone = () => {
      signal.removeEventListener('abort', onDone);
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(onDone, ms);
    signal.addEventListener('abort', onDone);
  });
}

type FileInputProps = {
  onChange: (file: File[] | undefined, event: ChangeEvent<HTMLInputElement>) => void;
  [index: string]: any; //eslint-disable-line
};

// eslint-disable-next-line react/display-name
const CivFileInput = forwardRef<HTMLInputElement, FileInputProps>(
  ({ onChange, ...restOfProps }, forwardedRef) => {
    const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(event.target?.files ?? []);
      onChange?.(files, event);
    };

    return <input onChange={handleChange} {...restOfProps} ref={forwardedRef} type="file" />;
  }
);

type UseS3UploadOptions = {
  endpoint?: string;
  endpointComplete?: string;
};

type UploadResult = {
  url: string | null;
  bucket: string;
  key: string;
  name?: string;
  size?: number;
  backend?: string;
};

type RequestOptions = {
  body: MixedObject;
  headers: HeadersInit;
};

type EndpointOptions = {
  request: RequestOptions;
};

type UploadToS3Options = {
  endpoint?: EndpointOptions;
};

type UploadToS3 = (
  file: File,
  type?: UploadType | UploadTypeUnion,
  options?: UploadToS3Options
) => Promise<UploadResult>;

type UseS3UploadTools = {
  FileInput: (props: any) => ReactElement<HTMLInputElement>; //eslint-disable-line
  openFileDialog: () => void;
  uploadToS3: UploadToS3;
  files: TrackedFile[];
  resetFiles: () => void;
  removeFile: (file: File, abort?: boolean) => void;
};

type UseS3Upload = (options?: UseS3UploadOptions) => UseS3UploadTools;

const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
  name: '',
  url: '',
};

export const useS3Upload: UseS3Upload = (options = {}) => {
  const ref = useRef<HTMLInputElement>();
  const state = useState<TrackedFile[]>([]);
  const fileUploadContext = useFileUploadContext();
  const [files, setFiles] = fileUploadContext ?? state;

  const openFileDialog = () => {
    if (ref.current) {
      ref.current.value = '';
      ref.current?.click();
    }
  };

  const resetFiles = () => {
    setFiles([]);
  };

  function removeFile(file: File, abort?: boolean) {
    if (abort) {
      const toAbort = files.find((x) => x.file === file);
      if (toAbort) toAbort.abort();
    }
    setFiles((state) => state.filter((x) => x.file !== file));
  }

  const endpoint = options.endpoint ?? '/api/upload';
  const completeEndpoint = options.endpointComplete ?? '/api/upload/complete';
  const abortEndpoint = options.endpointComplete ?? '/api/upload/abort';

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToS3: UploadToS3 = async (file, type = UploadType.Default, options = {}) => {
    const filename = encodeURIComponent(file.name);

    const requestExtras = options?.endpoint?.request ?? {
      headers: {},
      body: {},
    };

    const { size, type: mimeType } = file;
    const body = {
      filename,
      type,
      size,
      mimeType,
      ...requestExtras.body,
    };

    const headers = {
      ...requestExtras.headers,
      'Content-Type': 'application/json',
    };

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const data = await res.json();

    if (data.error) {
      console.error(data.error);
      throw data.error;
    } else {
      const { bucket, key, uploadId, urls, backend } = data;
      // The server sizes chunks against the file, so slicing by anything else would
      // send parts that don't match what it signed.
      const chunkSize: number = data.chunkSize ?? FILE_CHUNK_SIZE;

      const activeXhrs = new Set<XMLHttpRequest>();
      // TWO cancellations, deliberately not one.
      //
      // `teardownController` is INTERNAL: the worker trips it on the first fatal part
      // failure so sleeping workers stop and in-flight part xhrs die.
      // `userAbortController` records that the PERSON asked to cancel, and is tripped
      // only by the `abort` handed to the UI below.
      //
      // 🔴 Collapsing them is what made the relay fallback inert. The teardown always
      // fires before the relay gate below is reached, so a gate reading it saw "already
      // cancelled" on every failure — including the network-layer ones the relay exists
      // for — and the fallback could never run. The terminal status line had the mirror
      // of the same bug: every failed multipart upload reported as a user cancel.
      const teardownController = new AbortController();
      const userAbortController = new AbortController();
      const teardown = () => {
        teardownController.abort();
        for (const x of activeXhrs) x.abort();
      };
      // The only user-initiated cancel. It is handed to the UI on the tracked file, and
      // the cancel buttons in `FileInputUpload` and `MultiFileInputUpload`'s `UploadItem`
      // are what call it. `removeFile(file, true)` routes here too, though no caller
      // passes that second argument today.
      //
      // ⚠ Two things that look like cancels and are NOT, so nobody reads this as wider
      // cover than it is: `FileUploadProvider`'s unmount effect closes over the `files`
      // from its first render with `[]` deps, so it always iterates an empty array and
      // aborts nothing; and neither of the two call sites above can reach the relay
      // (both upload model/training files, and the relay is image-only). So on the one
      // path that CAN relay, nothing cancels an upload today — the `userAborted` gate
      // below is correct and tested, but it is not currently exercised in production.
      const abort = () => {
        userAbortController.abort();
        teardown();
      };
      setFiles((x) => {
        if (x.some((y) => y.file === file)) {
          return x.map((y) => (y.file === file ? ({ ...y, abort } as TrackedFile) : y));
        }
        return [...x, { file, ...pendingTrackedFile, abort } as TrackedFile];
      });

      function updateFile(trackedFile: Partial<TrackedFile>) {
        setFiles((x) =>
          x.map((y) => {
            if (y.file !== file) return y;
            return { ...y, ...trackedFile } as TrackedFile;
          })
        );
      }

      // Upload tracking - aggregate per-part bytes for concurrent uploads
      const uploadStart = Date.now();
      const partProgress = new Map<number, number>();
      const updateProgress = () => {
        let uploaded = 0;
        for (const v of partProgress.values()) uploaded += v;
        if (!uploaded) return;
        const secondsElapsed = (Date.now() - uploadStart) / 1000;
        const speed = uploaded / secondsElapsed;
        const timeRemaining = (size - uploaded) / speed;
        const progress = size ? (uploaded / size) * 100 : 0;
        updateFile({
          progress,
          uploaded,
          size,
          speed,
          timeRemaining,
          status: 'uploading',
          name: file.name,
        });
      };

      // Prepare abort
      const abortUpload = (failure?: PartFailureReason) =>
        fetch(abortEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            bucket,
            key,
            type,
            uploadId,
            backend,
            ...(failure ? { failure } : {}),
          }),
        });

      const completeUpload = () =>
        withRetries(
          async (remainingAttempts) => {
            const res = await fetch(completeEndpoint, {
              method: 'POST',
              headers,
              body: JSON.stringify({
                bucket,
                key,
                type,
                uploadId,
                parts,
                backend,
              }),
            });

            // Terminal statuses must not be re-POSTed — see isTerminalCompleteStatus.
            // This exemption was missing here (it existed only in s3-upload.store.ts),
            // so a terminal status was retried 4 times, 200 ms apart.
            if (!res.ok && !isTerminalCompleteStatus(res.status) && remainingAttempts > 0) {
              throw new Error('Failed to complete upload');
            }

            return res;
          },
          3,
          200
        );

      // Prepare part upload
      const partsCount = urls.length;
      const parts: { ETag: string; PartNumber: number }[] = [];
      const uploadPart = (url: string, i: number) =>
        new Promise<void>((resolve, reject) => {
          let eTag: string;
          const start = (i - 1) * chunkSize;
          const end = i * chunkSize;
          const part = i === partsCount ? file.slice(start) : file.slice(start, end);
          const xhr = new XMLHttpRequest();
          activeXhrs.add(xhr);
          xhr.upload.addEventListener('progress', ({ loaded }) => {
            partProgress.set(i, loaded);
            updateProgress();
          });
          xhr.upload.addEventListener('loadend', ({ loaded }) => {
            partProgress.set(i, loaded);
          });
          xhr.addEventListener('load', () => {
            eTag = xhr.getResponseHeader('ETag') ?? '';
          });
          xhr.addEventListener('loadend', () => {
            activeXhrs.delete(xhr);
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
              parts.push({ ETag: eTag, PartNumber: i });
              resolve();
            } else {
              const err: UploadPartError = {
                status: xhr.status,
                retryAfter: xhr.getResponseHeader('Retry-After'),
                partNumber: i,
              };
              reject(err);
            }
          });
          xhr.addEventListener('error', () => {
            activeXhrs.delete(xhr);
            reject({ status: null, networkError: true, partNumber: i } as UploadPartError);
          });
          xhr.addEventListener('abort', () => {
            activeXhrs.delete(xhr);
            reject({ status: null, aborted: true, partNumber: i } as UploadPartError);
          });
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.send(part);
        });

      // Worker pool over parts
      const queue = [...(urls as { url: string; partNumber: number }[])];
      const fatalErrorRef: { value: UploadPartError | null } = { value: null };

      const runWorker = async () => {
        while (queue.length > 0 && !fatalErrorRef.value) {
          if (teardownController.signal.aborted) {
            fatalErrorRef.value = { status: null, aborted: true };
            return;
          }
          const item = queue.shift();
          if (!item) return;

          let partError: UploadPartError | null = null;
          for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
            if (teardownController.signal.aborted) {
              partError = { status: null, aborted: true };
              break;
            }
            try {
              await uploadPart(item.url, item.partNumber);
              partError = null;
              break;
            } catch (err) {
              partError = err as UploadPartError;
              if (attempt === MAX_PART_ATTEMPTS - 1 || !shouldRetryPartError(partError)) break;
              await cancellableSleep(
                getPartRetryDelay(partError, attempt),
                teardownController.signal
              );
              if (teardownController.signal.aborted) {
                partError = { status: null, aborted: true };
                break;
              }
            }
          }
          if (partError) {
            // First failure wins so we don't mask a real error with a later abort
            if (!fatalErrorRef.value) fatalErrorRef.value = partError;
            // Cancel any in-flight part xhrs - signal alone won't kill them.
            // 🔴 `teardown()`, NOT `abort()`: this is the upload giving up on itself, and
            // calling the user-facing cancel here is exactly what left the relay fallback
            // and the terminal status unable to tell a failure from a cancel.
            teardown();
            return;
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CONCURRENT_PARTS, urls.length) }, () => runWorker())
      );

      if (fatalErrorRef.value) {
        const fatal = fatalErrorRef.value;

        // Relay fallback: a client whose network cannot reach the storage host at all
        // (DNS, TLS, connection reset — the ERR_CONNECTION_RESET class behind the 2026-09
        // image-upload ticket) re-sends the whole file through our own origin, the same
        // rescue `useCFImageUpload` got in #4573. Gated by shouldRelayOnPartFailure: only
        // network-layer failures, only image uploads on the image backend, only files
        // that fit the relay's body cap. A relayed upload reports the RELAY-MINTED key —
        // the fallback endpoint deliberately accepts no caller key, so the id this
        // returns is not the one the multipart session was opened with.
        if (
          shouldRelayOnPartFailure(fatal, {
            type,
            backend,
            fileSize: size,
            userAborted: userAbortController.signal.aborted,
          })
        ) {
          const relayedKey = await relayImageFallback(file, {
            // 🔴 The USER's signal, not the teardown's — which by here has ALWAYS fired.
            // Handing the teardown signal to the relay aborts its POST on the first tick,
            // so the fallback stays inert even once the gate above opens. A cancel during
            // the relay still cancels it, which is the behaviour this signal is for.
            signal: userAbortController.signal,
            sleep: (ms) => cancellableSleep(ms, userAbortController.signal),
            defaultRetryAfterSeconds: 2,
          });
          if (relayedKey) {
            updateFile({ status: 'success' });
            // The multipart session is now orphaned (its key holds no bytes) — tear it
            // down best-effort, after the success write so a teardown failure cannot
            // mask the outcome.
            try {
              await abortUpload(describePartFailure(fatal));
            } catch {
              /* the upload already succeeded */
            }
            return { url: relayedKey, bucket, key: relayedKey, name: file.name, size, backend };
          }
        }

        // Shared with the store client; the rules and the reason they are shared are on
        // `resolveTerminalUploadStatus`. The flag is the USER's, not the teardown's —
        // reading the teardown signal here made every failed upload report as a cancel.
        const status: TrackedFile['status'] = resolveTerminalUploadStatus(
          fatal,
          userAbortController.signal.aborted
        );
        updateFile({ status, file: undefined });
        await abortUpload(describePartFailure(fatal));
        return { url: null, bucket, key, backend };
      }

      // S3 requires parts ordered by PartNumber in CompleteMultipartUpload
      parts.sort((a, b) => a.PartNumber - b.PartNumber);

      // Complete the multipart upload
      const resp = await completeUpload();
      // this can happen with a 0-byte file, among other things
      if (!resp.ok) {
        updateFile({ status: 'error', file: undefined });
        await abortUpload();
        return { url: null, bucket, key, backend };
      }

      updateFile({ status: 'success' });

      const url = urls[0].url.split('?')[0];
      return { url, bucket, key, name: file.name, size: file.size, backend };
    }
  };

  return {
    FileInput: (props: any) => <CivFileInput {...props} ref={ref} style={{ display: 'none' }} />, //eslint-disable-line
    openFileDialog,
    uploadToS3,
    files,
    resetFiles,
    removeFile,
  };
};
