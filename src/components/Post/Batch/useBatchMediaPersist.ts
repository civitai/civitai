import { useEffect, useRef } from 'react';
import { trpc } from '~/utils/trpc';
import { useBatchComposerStore } from './batch-composer.store';
import type { UploadedMedia } from './batch-composer.utils';
import { groupIntoPosts, isPersistingMedia, toPersistImage } from './batch-composer.utils';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/** Below `POST_BATCH_PERSIST_MAX_IMAGES` so a burst of finished uploads costs a few short calls, not one long one. */
export const PERSIST_CHUNK_SIZE = 10;
export const PERSIST_DEBOUNCE_MS = 300;

export type PersistQueue<T> = {
  add: (item: T) => void;
  /** Sends what is queued now, without waiting for the window. */
  flush: () => void;
  dispose: () => void;
};

/**
 * Collects items for `delayMs` after the last add, then sends them in chunks of `chunkSize`,
 * each a separate `send` so one failed chunk does not fail the rest.
 */
export function createPersistQueue<T>(options: {
  chunkSize: number;
  delayMs: number;
  send: (items: T[]) => Promise<void>;
}): PersistQueue<T> {
  let queued: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (disposed || !queued.length) return;
    const items = queued;
    queued = [];
    for (const chunk of groupIntoPosts(items, options.chunkSize)) void options.send(chunk);
  };

  return {
    add: (item) => {
      if (disposed) return;
      queued.push(item);
      clearTimeout(timer);
      timer = setTimeout(flush, options.delayMs);
    },
    flush,
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      queued = [];
    },
  };
}

/**
 * Creates the draft row for every finished upload in the grid, so its scan starts while the
 * creator composes. A failed call marks its uploads `persistFailed`; clearing that flag (the
 * grid's retry) queues them again.
 */
export function useBatchMediaPersist() {
  const [media, patchMedia] = useBatchComposerStore((state) => [state.media, state.patchMedia]);
  const persist = trpc.post.persistBatchMedia.useMutation();
  const patchRef = useRef(patchMedia);
  patchRef.current = patchMedia;
  const mutateRef = useRef(persist.mutateAsync);
  mutateRef.current = persist.mutateAsync;
  const inFlight = useRef(new Set<string>());
  const queue = useRef<PersistQueue<UploadedMedia> | null>(null);

  useEffect(() => {
    const created = createPersistQueue<UploadedMedia>({
      chunkSize: PERSIST_CHUNK_SIZE,
      delayMs: PERSIST_DEBOUNCE_MS,
      send: async (items) => {
        try {
          const result = await mutateRef.current({ images: items.map(toPersistImage) });
          for (const { url, imageId } of result.images)
            patchRef.current(url, { imageId, ingestion: ImageIngestionStatus.Pending });
        } catch {
          for (const item of items) patchRef.current(item.url, { persistFailed: true });
        } finally {
          for (const item of items) inFlight.current.delete(item.url);
        }
      },
    });
    queue.current = created;
    return () => {
      created.dispose();
      queue.current = null;
    };
  }, []);

  useEffect(() => {
    for (const item of media) {
      if (!isPersistingMedia(item) || inFlight.current.has(item.url)) continue;
      inFlight.current.add(item.url);
      queue.current?.add(item as UploadedMedia);
    }
  }, [media]);
}
