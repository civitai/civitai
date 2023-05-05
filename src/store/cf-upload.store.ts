import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { v4 as uuidv4 } from 'uuid';
import negate from 'lodash/negate';

type UploadResult<T extends Record<string, unknown>> =
  | {
      success: false;
    }
  | {
      success: true;
      data: {
        url: string;
        id: string;
        uuid: string;
        meta: T;
      };
    };

type TrackedFile = {
  file: File;
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: 'pending' | 'error' | 'success' | 'uploading' | 'aborted' | 'timeout';
  abort: () => void;
  uuid: string;
  meta: Record<string, unknown>;
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
  upload: <T extends Record<string, unknown>>(
    args: {
      file: File;
      meta: T;
    },
    cb?: (result: UploadResult<T>) => Promise<void>
  ) => Promise<UploadResult<T>>;
};

export const useCFUploadStore = create<StoreProps>()(
  immer((set, get) => {
    function updateFile(uuid: string, trackedFile: Partial<TrackedFile>) {
      // console.log('updating', uuid, trackedFile);
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
          // if (state.items.length === 0) deregisterCatchNavigation();
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
        item?.abort();
      },
      upload: async <T extends Record<string, unknown>>(
        args: { file: File; meta: T },
        cb?: (result: UploadResult<T>) => Promise<void>
      ) => {
        const { file, meta } = args;
        const uuid = uuidv4();

        set((state) => {
          state.items.push({ ...pendingTrackedFile, uuid, file, meta });
        });

        const filename = encodeURIComponent(file.name);
        const res = await fetch('/api/image-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename, metadata: {} }),
        });

        const data = await res.json();

        if (data.error) {
          console.error(data.error);
          throw data.error;
        }

        const { id, uploadURL: url } = data;

        const xhr = new XMLHttpRequest();
        // xhr.timeout = 2000;
        const xhrResult = await new Promise<boolean>((resolve) => {
          let uploadStart = Date.now();

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
                status: 'uploading',
                abort: () => xhr.abort(),
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
          xhr.addEventListener('timeout', () => {
            updateFile(uuid, { status: 'timeout' });
            resolve(false);
          });
          xhr.open('PUT', url, true);
          xhr.send(file);
        });

        const payload = (
          xhrResult
            ? {
                success: true,
                data: { url: url.split('?')[0], id, meta, uuid },
              }
            : { success: false }
        ) satisfies UploadResult<T>;

        await cb?.(payload);
        return payload;
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
