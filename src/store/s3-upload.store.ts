import { negate } from 'lodash-es';
import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { UploadType } from '~/server/common/enums';
import { bytesToKB } from '~/utils/number-helpers';

import { useCatchNavigationStore } from './catch-navigation.store';

type UploadResult = {
  url: string;
  bucket: string;
  key: string;
  name: string;
  size: number;
  uuid: string;
  meta?: Record<string, unknown>;
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
      }: {
        url: string;
        bucket: string;
        key: string;
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

        const data = (await res.json()) as ApiUploadResponse;

        if ('error' in data) {
          console.error(data.error);
          throw data.error;
        } else {
          const { bucket, key, uploadId, urls } = data;
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
            size: file.size ? bytesToKB(file.size) : 0,
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
              updateFile(pendingItem.uuid, {
                progress,
                uploaded,
                size,
                speed,
                timeRemaining,
                status: 'uploading',
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
              }),
            });

          // Prepare part upload
          const partsCount = urls.length;
          const uploadPart = (url: string, i: number) =>
            new Promise<UploadStatus>((resolve) => {
              let eTag: string;
              const start = (i - 1) * FILE_CHUNK_SIZE;
              const end = i * FILE_CHUNK_SIZE;
              const part = i === partsCount ? file.slice(start) : file.slice(start, end);
              const xhr = new XMLHttpRequest();
              xhr.upload.addEventListener('progress', updateProgress);
              xhr.upload.addEventListener('loadend', ({ loaded }) => {
                totalUploaded += loaded;
              });
              xhr.addEventListener('loadend', () => {
                const success = xhr.readyState === 4 && xhr.status === 200;
                if (success) {
                  parts.push({ ETag: eTag, PartNumber: i });
                  resolve('success');
                }
              });
              xhr.addEventListener('load', () => {
                eTag = xhr.getResponseHeader('ETag') ?? '';
              });
              xhr.addEventListener('error', () => resolve('error'));
              xhr.addEventListener('abort', () => resolve('aborted'));
              xhr.open('PUT', url);
              xhr.setRequestHeader('Content-Type', 'application/octet-stream');
              xhr.send(part);
              // currentXhr = xhr;
              try {
                updateFile(pendingItem.uuid, {
                  abort: () => {
                    if (xhr) xhr.abort();
                  },
                });
              } catch (e) {
                resolve('error');
              }
            });

          // Make part requests
          const parts: { ETag: string; PartNumber: number }[] = [];
          for (const { url, partNumber } of urls as { url: string; partNumber: number }[]) {
            let uploadStatus: UploadStatus = 'pending';

            // Retry up to 3 times
            let retryCount = 0;
            while (retryCount < 3) {
              uploadStatus = await uploadPart(url, partNumber);
              if (uploadStatus !== 'error') break;
              retryCount++;
              await new Promise((resolve) => setTimeout(resolve, 5000 * retryCount));
            }

            // If we failed to upload, abort the whole thing
            if (uploadStatus !== 'success') {
              try {
                updateFile(pendingItem.uuid, {
                  status: uploadStatus,
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
          }

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
          const payload = preparePayload(pendingItem.uuid, { url, bucket, key });

          cb?.(payload);
          return payload;
        }
      },
    };
  })
);

const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
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
