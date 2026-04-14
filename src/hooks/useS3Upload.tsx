import type { ChangeEvent, ReactElement } from 'react';
import React, { forwardRef, useRef, useState } from 'react';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { useFileUploadContext } from '~/components/FileUpload/FileUploadProvider';
import type { UploadTypeUnion } from '~/server/common/enums';
import { UploadType } from '~/server/common/enums';
import { withRetries } from '~/utils/errorHandling';

const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_PART_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 60_000;
const MIN_RETRY_AFTER_MS = 1000;

type UploadPartError = {
  status: number | null;
  retryAfter?: string | null;
  networkError?: boolean;
  aborted?: boolean;
};

function shouldRetryPartError(err: UploadPartError) {
  if (err.aborted) return false;
  if (err.networkError) return true;
  if (err.status === 429) return true;
  if (err.status !== null && err.status >= 500) return true;
  return false;
}

function getRetryDelay(err: UploadPartError, attempt: number) {
  if (err.retryAfter) {
    const seconds = Number(err.retryAfter);
    if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const dateMs = Date.parse(err.retryAfter);
    if (!isNaN(dateMs)) {
      // Floor to avoid hammering the server when client clock is skewed.
      const delta = Math.max(dateMs - Date.now(), MIN_RETRY_AFTER_MS);
      return Math.min(delta, MAX_BACKOFF_MS);
    }
  }
  // Exponential backoff with jitter: ~1s, 2s, 4s + up to 1s jitter
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
  return base + Math.random() * 1000;
}

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

      let currentXhr: XMLHttpRequest;
      const abortController = new AbortController();
      const abort = () => {
        abortController.abort();
        if (currentXhr) currentXhr.abort();
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

      // Upload tracking
      const uploadStart = Date.now();
      let totalUploaded = 0;
      const updateProgress = ({ loaded }: ProgressEvent) => {
        const uploaded = totalUploaded + (loaded ?? 0);
        if (uploaded) {
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
        }
      };

      // Prepare abort
      const abortUpload = () =>
        fetch(abortEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            bucket,
            key,
            type,
            uploadId,
            backend,
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

            if (!res.ok && remainingAttempts > 0) {
              throw new Error('Failed to complete upload');
            }

            return res;
          },
          3,
          200
        );

      // Prepare part upload
      const partsCount = urls.length;
      const uploadPart = (url: string, i: number) =>
        new Promise<void>((resolve, reject) => {
          let eTag: string;
          const start = (i - 1) * FILE_CHUNK_SIZE;
          const end = i * FILE_CHUNK_SIZE;
          const part = i === partsCount ? file.slice(start) : file.slice(start, end);
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener('progress', updateProgress);
          xhr.upload.addEventListener('loadend', ({ loaded }) => {
            totalUploaded += loaded;
          });
          xhr.addEventListener('load', () => {
            eTag = xhr.getResponseHeader('ETag') ?? '';
          });
          xhr.addEventListener('loadend', () => {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 200) {
              parts.push({ ETag: eTag, PartNumber: i });
              resolve();
            } else {
              const err: UploadPartError = {
                status: xhr.status,
                retryAfter: xhr.getResponseHeader('Retry-After'),
              };
              reject(err);
            }
          });
          xhr.addEventListener('error', () =>
            reject({ status: null, networkError: true } as UploadPartError)
          );
          xhr.addEventListener('abort', () =>
            reject({ status: null, aborted: true } as UploadPartError)
          );
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.send(part);
          currentXhr = xhr;
        });

      // Make part requests
      const parts: { ETag: string; PartNumber: number }[] = [];
      for (const { url, partNumber } of urls as { url: string; partNumber: number }[]) {
        let partError: UploadPartError | null = null;

        for (let attempt = 0; attempt < MAX_PART_ATTEMPTS; attempt++) {
          if (abortController.signal.aborted) {
            partError = { status: null, aborted: true };
            break;
          }
          try {
            await uploadPart(url, partNumber);
            partError = null;
            break;
          } catch (err) {
            partError = err as UploadPartError;
            if (attempt === MAX_PART_ATTEMPTS - 1 || !shouldRetryPartError(partError)) break;
            await cancellableSleep(getRetryDelay(partError, attempt), abortController.signal);
            if (abortController.signal.aborted) {
              partError = { status: null, aborted: true };
              break;
            }
          }
        }

        // If we failed to upload, abort the whole thing
        if (partError) {
          const status: TrackedFile['status'] = partError.aborted ? 'aborted' : 'error';
          updateFile({ status, file: undefined });
          await abortUpload();
          return { url: null, bucket, key, backend };
        }
      }

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
