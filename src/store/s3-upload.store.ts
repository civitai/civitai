import { negate } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { UploadType } from '~/server/common/enums';

import { useCatchNavigationStore } from './catch-navigation.store';

type UploadResult = {
  url: string;
  bucket: string;
  key: string;
  name: string;
  size: number;
  uuid: string;
  meta?: Record<string, unknown>;
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

type UseS3UploadOptions = {
  endpoint?: string;
  endpointComplete?: string;
};

type ApiUploadResponse =
  | {
      urls: Array<{ url: string; partNumber: number }>;
      bucket: string;
      key: string;
      uploadId?: string;
      backend?: string;
    }
  | { error: string };

type UploadStatus = 'pending' | 'error' | 'success' | 'aborted';

type StoreProps = {
  items: TrackedFile[];
  setItems: (dispatch: (items: TrackedFile[]) => TrackedFile[]) => void;
  clear: (predicate?: (item: TrackedFile) => boolean) => void;
  getStatus: (predicate?: (item: TrackedFile) => boolean) => {
    pending: number;
    error: number;
    uploading: number;
    success: number;
    aborted: number;
  };
  abort: (uuid: string) => void;
  updateMeta: (
    uuid: string,
    dispatch: (meta: Record<string, unknown>) => Record<string, unknown>
  ) => void;
  upload: (
    args: {
      file: File;
      type: UploadType;
      meta?: Record<string, unknown>;
      options?: UploadToS3Options;
    },
    cb?: ({ url, bucket, key, name, size }: UploadResult) => void
  ) => Promise<UploadResult | undefined>;
};

export const useS3UploadStore = create<StoreProps>()(
  immer((set, get) => {
    const endpoint = '/api/upload';
    const completeEndpoint = '/api/upload/complete';
    const abortEndpoint = '/api/upload/abort';

    function preparePayload(
      uuid: string,
      {
        url,
        bucket,
        key,
        backend,
      }: {
        url: string;
        bucket: string;
        key: string;
        backend?: string;
      }
    ): UploadResult {
      const items = get().items;
      const index = items.findIndex((x) => x.uuid === uuid);
      if (index === -1) throw new Error('index out of bounds');
      const item = items[index];
      return {
        url,
        bucket,
        key,
        name: item.name,
        size: item.size,
        meta: item.meta,
        uuid: item.uuid,
        backend,
      };
    }

    function updateFile(uuid: string, trackedFile: Partial<TrackedFile>) {
      set((state) => {
        const index = state.items.findIndex((x) => x.uuid === uuid);
        if (index === -1) throw new Error('index out of bounds');
        state.items[index] = { ...state.items[index], ...trackedFile };
      });
    }

    return {
      items: [] as TrackedFile[],
      setItems: (dispatch) => {
        set((state) => {
          const items = get().items;
          state.items = dispatch(items);
        });
      },
      clear: (predicate) => {
        set((state) => {
          state.items = predicate ? state.items.filter(negate(predicate)) : [];
          if (state.items.length === 0) deregisterCatchNavigation();
        });
      },
      getStatus: (predicate) => {
        const items = predicate ? get().items.filter(predicate) : get().items;
        return {
          pending: items.filter((x) => x.status === 'pending').length,
          error: items.filter((x) => x.status === 'error').length,
          uploading: items.filter((x) => x.status === 'uploading').length,
          success: items.filter((x) => x.status === 'success').length,
          aborted: items.filter((x) => x.status === 'aborted').length,
        };
      },
      updateMeta: (uuid, dispatch) => {
        set((state) => {
          const items = get().items;
          const index = items.findIndex((x) => x.uuid === uuid);
          if (index === -1) throw new Error('index out of bounds');

          const { meta } = state.items[index];
          if (meta) state.items[index].meta = dispatch(meta);
        });
      },
      abort: (uuid) => {
        const item = get().items.find((x) => x.uuid === uuid);
        item?.abort();
      },
      upload: async ({ file, type, options, meta }, cb) => {
        // register catch navigation if beginning upload queue
        if (get().items.filter((item) => item.status === 'uploading').length === 0)
          registerCatchNavigation();
        const filename = encodeURIComponent(file.name);

        const requestExtras = options?.endpoint?.request ?? {
          headers: {},
          body: {},
        };

        const { size } = file;
        const body = {
          filename,
          type,
          size,
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

        // TODO handle a non-json response (like a 403)
        const data = (await res.json()) as ApiUploadResponse;

        if ('error' in data) {
          console.error(data.error);
          throw data.error;
        } else {
          const { bucket, key, uploadId, urls, backend } = data;
          const uuid = uuidv4();

          // let currentXhr: XMLHttpRequest;
          // const abort = () => {
          //   console.log({ currentXhr });
          //   if (currentXhr) currentXhr.abort();
          // };

          let index = -1;
          const trackedFile = {
            ...pendingTrackedFile,
            file,
            // `size` is tracked in BYTES throughout the store: progress math
            // (uploaded/size) and updateProgress() both use raw bytes, and every
            // consumer of the upload-result `size` (FilesProvider, MultiFileInputUpload)
            // applies bytesToKB() itself. Initializing in KB here let a stale KB value
            // leak into the upload result when progress never overwrote it before
            // completion, causing the consumer to divide by 1024 a second time and
            // store ModelFile.sizeKB as MB (~1024x too small). Keep it bytes.
            size: file.size ?? 0,
            uuid,
            meta,
            name: file.name,
          };
          const existingItem = get().items.find((x, i) => {
            if (x.file === file) {
              index = i;
              return true;
            }

            return false;
          });
          const pendingItem = { ...trackedFile, ...existingItem };

          set((state) => {
            if (index !== -1) state.items[index] = pendingItem;
            else state.items.push(trackedFile);
          });

          // Upload tracking - track per-part bytes so concurrent uploads aggregate correctly
          const uploadStart = Date.now();
          const partProgress = new Map<number, number>();
          const activeXhrs = new Set<XMLHttpRequest>();
          const updateProgress = () => {
            let uploaded = 0;
            for (const v of partProgress.values()) uploaded += v;
            if (!uploaded) return;
            const secondsElapsed = (Date.now() - uploadStart) / 1000;
            const speed = uploaded / secondsElapsed;
            const timeRemaining = (size - uploaded) / speed;
            const progress = size ? (uploaded / size) * 100 : 0;
            updateFile(pendingItem.uuid, {
              progress,
              uploaded,
              size,
              speed,
              timeRemaining,
              status: 'uploading',
            });
          };

          // Coalesce progress writes to one store update per animation frame. Concurrent
          // parts/files fire 'progress' events far faster than the screen refreshes, so
          // without this each byte event triggers a zustand set + re-render of every row.
          let rafId: number | null = null;
          const scheduleProgress = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(() => {
              rafId = null;
              updateProgress();
            });
          };
          const cancelProgress = () => {
            if (rafId !== null) {
              cancelAnimationFrame(rafId);
              rafId = null;
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
            fetch(completeEndpoint, {
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

          // Prepare part upload
          const partsCount = urls.length;
          const parts: { ETag: string; PartNumber: number }[] = [];
          const uploadPart = (url: string, i: number) =>
            new Promise<UploadStatus>((resolve, reject) => {
              let eTag: string;
              const start = (i - 1) * FILE_CHUNK_SIZE;
              const end = i * FILE_CHUNK_SIZE;
              const part = i === partsCount ? file.slice(start) : file.slice(start, end);
              const xhr = new XMLHttpRequest();
              activeXhrs.add(xhr);
              xhr.upload.addEventListener('progress', ({ loaded }) => {
                partProgress.set(i, loaded);
                scheduleProgress();
              });
              xhr.upload.addEventListener('loadend', ({ loaded }) => {
                partProgress.set(i, loaded);
              });
              xhr.addEventListener('loadend', () => {
                activeXhrs.delete(xhr);
                const success = xhr.readyState === 4 && xhr.status === 200;
                if (success) {
                  parts.push({ ETag: eTag, PartNumber: i });
                  resolve('success');
                }
              });
              xhr.addEventListener('load', () => {
                eTag = xhr.getResponseHeader('ETag') ?? '';
              });
              xhr.addEventListener('error', () => {
                activeXhrs.delete(xhr);
                reject('error');
              });
              xhr.addEventListener('abort', () => {
                activeXhrs.delete(xhr);
                reject('aborted');
              });
              xhr.open('PUT', url);
              xhr.setRequestHeader('Content-Type', 'application/octet-stream');
              xhr.send(part);
            });

          // Shared cancellation: trips on user abort or first fatal failure so sleeping
          // retry workers don't fire zombie PUTs after the upload has been torn down.
          const cancelController = new AbortController();
          const cancellableSleep = (ms: number) =>
            new Promise<void>((resolve) => {
              if (cancelController.signal.aborted) return resolve();
              const onDone = () => {
                cancelController.signal.removeEventListener('abort', onDone);
                clearTimeout(t);
                resolve();
              };
              const t = setTimeout(onDone, ms);
              cancelController.signal.addEventListener('abort', onDone);
            });

          // Register abort that trips the signal and cancels every in-flight part xhr
          try {
            updateFile(pendingItem.uuid, {
              abort: () => {
                cancelProgress();
                cancelController.abort();
                for (const x of activeXhrs) x.abort();
              },
            });
          } catch (e) {
            // ignore - upload will surface the failure
          }

          // Worker pool over remaining parts
          const queue = [...(urls as { url: string; partNumber: number }[])];
          let failureStatus: UploadStatus | null = null;

          const runWorker = async () => {
            while (queue.length > 0 && !failureStatus) {
              if (cancelController.signal.aborted) return;
              const item = queue.shift();
              if (!item) return;
              let status: UploadStatus = 'pending';
              let retryCount = 0;
              while (retryCount < 3) {
                if (cancelController.signal.aborted) return;
                try {
                  status = await uploadPart(item.url, item.partNumber);
                } catch (e) {
                  status = e === 'aborted' ? 'aborted' : 'error';
                }
                if (status !== 'error') break;
                retryCount++;
                await cancellableSleep(5000 * retryCount);
              }
              if (status !== 'success') {
                // First failure wins so a real error doesn't get masked by a later abort
                if (!failureStatus) failureStatus = status;
                cancelController.abort();
                for (const x of activeXhrs) x.abort();
                return;
              }
            }
          };

          await Promise.all(
            Array.from({ length: Math.min(CONCURRENT_PARTS, urls.length) }, () => runWorker())
          );

          // No more progress events past this point; drop any queued frame so it can't
          // clobber the terminal status written below.
          cancelProgress();

          if (failureStatus) {
            try {
              updateFile(pendingItem.uuid, {
                status: failureStatus,
                progress: 0,
                speed: 0,
                timeRemaining: 0,
                uploaded: 0,
              });
              await abortUpload();
            } catch (err) {
              console.error('Failed to abort upload');
              console.error(err);
            }
            return;
          }

          // S3 requires parts ordered by PartNumber in CompleteMultipartUpload
          parts.sort((a, b) => a.PartNumber - b.PartNumber);

          // Complete the multipart upload
          const completeResult = await completeUpload().catch((err) => {
            console.error('Failed to complete upload');
            console.error(err);
            updateFile(pendingItem.uuid, {
              status: 'error',
              progress: 0,
              speed: 0,
              timeRemaining: 0,
              uploaded: 0,
            });

            return { ok: false };
          });
          if (!completeResult.ok) return;

          updateFile(pendingItem.uuid, { status: 'success' });

          const url = urls[0].url.split('?')[0];
          const payload = preparePayload(pendingItem.uuid, { url, bucket, key, backend });

          cb?.(payload);
          return payload;
        }
      },
    };
  })
);

const FILE_CHUNK_SIZE = 25 * 1024 * 1024; // 25 MB
const CONCURRENT_PARTS = 4;
const pendingTrackedFile: Omit<TrackedFile, 'uuid' | 'file' | 'name'> = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
  meta: {},
};

const registerCatchNavigation = () => {
  const { handlers, register } = useCatchNavigationStore.getState();
  const index = handlers.findIndex((x) => x.name === 'file-upload');
  if (index === -1)
    register({
      name: 'file-upload',
      message: 'Files are still uploading. Upload progress will be lost',
      predicate: () => useS3UploadStore.getState().getStatus().uploading > 0,
      event: 'beforeunload',
    });
};
const deregisterCatchNavigation = () => {
  useCatchNavigationStore.getState().deregister('file-upload');
};
