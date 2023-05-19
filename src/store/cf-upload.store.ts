import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuidv4 } from 'uuid';
import { negate } from 'lodash-es';
import { Queue } from '~/utils/queue';

type UploadResult =
  | { success: false }
  | {
      success: true;
      data: {
        url: string;
        id: string;
        uuid: string;
      };
    };

type TrackedFile = {
  file: File;
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: 'pending' | 'error' | 'success' | 'uploading' | 'aborted' | 'dequeued';
  abort: () => void;
  uuid: string;
};

type StoreProps = {
  items: TrackedFile[];
  clear: (predicate?: (item: TrackedFile) => boolean) => void;
  getStatus: () => {
    pending: number;
    error: number;
    uploading: number;
    success: number;
    aborted: number;
  };
  abort: (uuid: string) => void;
  upload: (file: File, cb?: (result: UploadResult) => Promise<void>) => void;
};

const maxConcurrency = 5;
const concurrency = typeof navigator !== 'undefined' ? navigator?.hardwareConcurrency ?? 1 : 1;
const queue = new Queue(Math.min(maxConcurrency, concurrency));

export const useCFUploadStore = create<StoreProps>()(
  immer((set, get) => {
    function updateFile(uuid: string, trackedFile: Partial<TrackedFile>) {
      set((state) => {
        const index = state.items.findIndex((x) => x.uuid === uuid);
        if (index > -1) state.items[index] = { ...state.items[index], ...trackedFile };
      });
    }

    return {
      items: [],
      clear: (predicate) => {
        set((state) => {
          state.items = predicate ? state.items.filter(negate(predicate)) : [];
        });
      },
      getStatus: () => {
        const items = get().items;
        return {
          pending: items.filter((x) => x.status === 'pending').length,
          error: items.filter((x) => x.status === 'error').length,
          uploading: items.filter((x) => x.status === 'uploading').length,
          success: items.filter((x) => x.status === 'success').length,
          aborted: items.filter((x) => x.status === 'aborted').length,
        };
      },
      abort: (uuid) => {
        const item = get().items.find((x) => x.uuid === uuid);
        if (!item) return;
        item.abort();
      },
      upload: (file, cb) => {
        const uuid = uuidv4();

        const task = async () => {
          const filename = encodeURIComponent(file.name);
          const controller = new AbortController();

          // allow abort of fetch request
          updateFile(uuid, {
            status: 'uploading',
            abort: () => {
              controller.abort();
              updateFile(uuid, { status: 'aborted' });
            },
          });

          const res = await fetch('/api/image-upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, metadata: {} }),
            signal: controller.signal,
          });

          const data = await res.json();

          if (data.error) throw data.error;

          const { id, uploadURL: url } = data;

          const xhr = new XMLHttpRequest();
          const xhrResult = await new Promise<boolean>((resolve) => {
            let uploadStart = Date.now();

            // allow abort of xhr request
            updateFile(uuid, { abort: () => xhr.abort() });

            xhr.upload.addEventListener('loadstart', () => {
              uploadStart = Date.now();
            });
            xhr.upload.addEventListener('progress', ({ loaded, total }) => {
              const uploaded = loaded ?? 0;
              const size = total ?? 0;

              if (uploaded) {
                const secondsElapsed = (Date.now() - uploadStart) / 1000;
                const speed = uploaded / secondsElapsed;
                const timeRemaining = (size - uploaded) / speed;
                const progress = size ? (uploaded / size) * 100 : 0;

                updateFile(uuid, {
                  uploaded,
                  size,
                  progress,
                  timeRemaining,
                  speed,
                });
              }
            });
            xhr.addEventListener('loadend', () => {
              const success = xhr.readyState === 4 && xhr.status === 200;
              if (success) {
                updateFile(uuid, { status: 'success' });
              }
              resolve(success);
            });
            xhr.addEventListener('error', () => {
              updateFile(uuid, { status: 'error' });
              resolve(false);
            });
            xhr.addEventListener('abort', () => {
              updateFile(uuid, { status: 'aborted' });
              resolve(false);
            });
            xhr.open('PUT', url, true);
            xhr.send(file);
          });

          const payload: UploadResult = xhrResult
            ? {
                success: true,
                data: { url: url.split('?')[0], id, uuid },
              }
            : { success: false };

          await cb?.(payload);

          // clear tracked file after success
          setTimeout(() => {
            get().clear((x) => x.file === file);
          }, 3000);
        };

        // set initial value
        set((state) => {
          state.items.push({
            ...pendingTrackedFile,
            uuid,
            file,
            abort: () => {
              queue.dequeue(task);
              updateFile(uuid, { status: 'dequeued' });
            },
          });
        });

        queue.enqueu(task);
      },
    };
  })
);

const pendingTrackedFile: Omit<TrackedFile, 'uuid' | 'file' | 'meta'> = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
};
