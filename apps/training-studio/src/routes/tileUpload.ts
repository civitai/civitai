import { isAbort, uploadFile, UploadError, type UploadedBlob } from '$lib/upload';
import type { Img } from './trainingFlow';

/** In-flight requests by key, so removing a tile (or leaving the step) can abort its request. */
export function inFlight<K>() {
  const controllers = new Map<K, AbortController>();
  const abort = (key: K) => {
    controllers.get(key)?.abort();
    controllers.delete(key);
  };
  return {
    abort,
    abortAll() {
      for (const key of [...controllers.keys()]) abort(key);
    },
    /** Run `task` as `key`'s request, aborting whatever that key had in flight before. */
    async run<T>(key: K, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      controllers.get(key)?.abort();
      const controller = new AbortController();
      controllers.set(key, controller);
      try {
        return await task(controller.signal);
      } finally {
        // A newer run for the same key owns the slot now.
        if (controllers.get(key) === controller) controllers.delete(key);
      }
    },
  };
}

/** The tile fields a failed upload leaves, or null for an abort — whoever aborted owns the tile. */
export function uploadFailure(err: unknown): Pick<Img, 'status' | 'message'> | null {
  if (isAbort(err)) return null;
  return {
    status: err instanceof UploadError && err.permanent ? 'blocked' : 'error',
    message: err instanceof Error ? err.message : 'Upload failed',
  };
}

export const uploadedFields = (blob: UploadedBlob): Partial<Img> => ({
  status: 'uploaded',
  progress: 1,
  blobId: blob.id,
  blobUrl: blob.url ?? undefined,
  nsfwLevel: blob.nsfwLevel ?? undefined,
});

/** Upload `file` into the tile `patch` writes to, showing progress and any failure on it. Resolves with
 *  the scanned blob — without marking the tile uploaded, so the caller can still drop a duplicate — or
 *  null when the upload failed or was aborted. */
export async function uploadTile(
  file: File,
  patch: (values: Partial<Img>) => void,
  signal: AbortSignal
): Promise<UploadedBlob | null> {
  patch({ status: 'uploading', progress: 0, message: undefined });
  try {
    return await uploadFile(file, (progress) => patch({ progress }), signal);
  } catch (err) {
    const failure = uploadFailure(err);
    if (failure) patch(failure);
    return null;
  }
}
