import { negate } from 'lodash-es';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { UploadType } from '~/server/common/enums';
import type { MultipartRequestOptions, UploadProgress } from '~/utils/multipart-upload';
import { startMultipartUpload } from '~/utils/multipart-upload';
import { describePartFailure, resolveUploadRowStatus } from '~/utils/upload-retry';

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

type UploadStatus = 'pending' | 'error' | 'success' | 'aborted';

/**
 * Uploads that share an `id` (a model version, say) can be made to run one at a time. A
 * `sequential` upload starts only when nothing else in its group is running; the others in the
 * group are unaffected, so turning sequential off mid-way just stops queueing new files.
 */
type UploadGroup = { id: string; sequential: boolean };

type GroupWaiter = { grant: () => void; cancel: () => void };
type GroupState = { active: number; waiting: GroupWaiter[] };

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
      options?: MultipartRequestOptions;
      uploadGroup?: UploadGroup;
    },
    cb?: ({ url, bucket, key, name, size }: UploadResult) => void
  ) => Promise<UploadResult | undefined>;
};

export const useS3UploadStore = create<StoreProps>()(
  immer((set, get) => {
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

    const groups = new Map<string, GroupState>();

    function admitWaiting(groupId: string) {
      const group = groups.get(groupId);
      if (!group) return;
      while (group.active === 0 && group.waiting.length > 0) group.waiting.shift()?.grant();
      if (group.active === 0) groups.delete(groupId);
    }

    /**
     * Resolves with the release to call when the upload is over, or `null` when the file was
     * cancelled or removed while it waited. A waiting file shows as a 'pending' row, and the
     * server is not asked for part URLs until its turn, so they cannot expire in the queue.
     */
    function enterGroup(
      { file, meta }: Pick<Parameters<StoreProps['upload']>[0], 'file' | 'meta'>,
      { id, sequential }: UploadGroup
    ): Promise<(() => void) | null> {
      const group = groups.get(id) ?? { active: 0, waiting: [] };
      groups.set(id, group);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        group.active--;
        admitWaiting(id);
      };

      if (!sequential || (group.active === 0 && group.waiting.length === 0)) {
        group.active++;
        return Promise.resolve(release);
      }

      registerCatchNavigation();
      return new Promise((resolve) => {
        let uuid = crypto.randomUUID();
        const waiter: GroupWaiter = {
          grant: () => {
            if (!get().items.some((x) => x.uuid === uuid)) return resolve(null);
            group.active++;
            // Past this point the file is on its way; the upload sets its own abort once it
            // has URLs, so a cancel in between must not pretend to have stopped it.
            updateFile(uuid, { abort: () => undefined });
            resolve(release);
          },
          cancel: () => {
            group.waiting = group.waiting.filter((x) => x !== waiter);
            try {
              updateFile(uuid, { status: 'aborted' });
            } catch {
              // the row was cleared while it waited
            }
            resolve(null);
            admitWaiting(id);
          },
        };
        group.waiting.push(waiter);

        // A retried file already has a row, which the upload merges into when its turn comes.
        const existing = get().items.find((x) => x.file === file);
        if (existing) {
          uuid = existing.uuid;
          updateFile(uuid, {
            status: 'pending',
            progress: 0,
            uploaded: 0,
            speed: 0,
            timeRemaining: 0,
            abort: waiter.cancel,
          });
        } else {
          set((state) => {
            state.items.push({
              ...pendingTrackedFile,
              file,
              size: file.size ?? 0,
              uuid,
              meta,
              name: file.name,
              abort: waiter.cancel,
            });
          });
        }
      });
    }

    function withUploadGroup(run: StoreProps['upload']): StoreProps['upload'] {
      return async (args, cb) => {
        if (!args.uploadGroup) return run(args, cb);
        const release = await enterGroup(args, args.uploadGroup);
        if (!release) return undefined;
        try {
          return await run(args, cb);
        } catch (err) {
          // A file that never got as far as a row of its own is still sitting as 'pending'.
          if (args.uploadGroup.sequential) {
            const row = get().items.find((x) => x.file === args.file);
            if (row?.status === 'pending') updateFile(row.uuid, { status: 'error' });
          }
          throw err;
        } finally {
          release();
        }
      };
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
      upload: withUploadGroup(async ({ file, type, options, meta }, cb) => {
        // register catch navigation if beginning upload queue
        if (get().items.filter((item) => item.status === 'uploading').length === 0)
          registerCatchNavigation();

        const upload = await startMultipartUpload({ file, type, options });
        const { size } = file;
        const uuid = crypto.randomUUID();

        let index = -1;
        const trackedFile = {
          ...pendingTrackedFile,
          file,
          // BYTES, not KB: consumers apply bytesToKB() themselves, so a KB value here is divided
          // twice and ModelFile.sizeKB is stored ~1024x too small.
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

        // One store write per animation frame: concurrent parts fire 'progress' far faster than
        // the screen refreshes, and each write re-renders every row.
        let latestProgress: UploadProgress | null = null;
        let rafId: number | null = null;
        const scheduleProgress = (progress: UploadProgress) => {
          latestProgress = progress;
          if (rafId !== null) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            if (latestProgress)
              updateFile(pendingItem.uuid, { ...latestProgress, status: 'uploading' });
          });
        };
        const cancelProgress = () => {
          if (rafId !== null) {
            cancelAnimationFrame(rafId);
            rafId = null;
          }
        };

        // updateFile() throws when the row was already dropped (clear(), a navigation), and the
        // session still needs aborting then, so this must not share a try block with the abort.
        const setTerminalStatus = (status: UploadStatus) => {
          try {
            updateFile(pendingItem.uuid, {
              status,
              progress: 0,
              speed: 0,
              timeRemaining: 0,
              uploaded: 0,
            });
          } catch (err) {
            console.error('Failed to write terminal upload status');
            console.error(err);
          }
        };

        const userAbortController = new AbortController();
        try {
          updateFile(pendingItem.uuid, {
            abort: () => {
              cancelProgress();
              userAbortController.abort();
            },
          });
        } catch (e) {
          // ignore - upload will surface the failure
        }

        const fatal = await upload.transferParts({
          signal: userAbortController.signal,
          onProgress: scheduleProgress,
        });

        // No more progress events past this point; drop any queued frame so it can't
        // clobber the terminal status written below.
        cancelProgress();

        if (fatal) {
          setTerminalStatus(
            resolveUploadRowStatus(fatal, { userAborted: userAbortController.signal.aborted })
          );
          await upload.abort(describePartFailure(fatal));
          return;
        }

        const completeResult = await upload.complete();
        // A failed completion must leave a terminal 'error' (the bytes are stored but no file record
        // exists) and must tear the session down, or every stored part stays open and billable.
        if (!completeResult?.ok) {
          setTerminalStatus('error');
          await upload.abort();
          return;
        }

        // The final part's bytes land on 'loadend', which doesn't report progress —
        // without this the row would settle on the last rendered percentage (e.g. 87%)
        // instead of a finished bar.
        updateFile(pendingItem.uuid, {
          status: 'success',
          progress: 100,
          uploaded: size,
          speed: 0,
          timeRemaining: 0,
        });

        const { url, bucket, key, backend } = upload;
        const payload = preparePayload(pendingItem.uuid, { url, bucket, key, backend });

        cb?.(payload);
        return payload;
      }),
    };
  })
);

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
      // A file waiting its turn in a sequential group is as lost on leave as one mid-transfer.
      predicate: () => {
        const { uploading, pending } = useS3UploadStore.getState().getStatus();
        return uploading + pending > 0;
      },
      event: 'beforeunload',
    });
};
const deregisterCatchNavigation = () => {
  useCatchNavigationStore.getState().deregister('file-upload');
};
