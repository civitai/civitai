import { useState } from 'react';
import { constants } from '~/server/common/constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { auditImageMeta, preprocessFile } from '~/utils/media-preprocessors';
import { showErrorNotification } from '~/utils/notifications';
import { isDefined } from '~/utils/type-guards';
import { v4 as uuidv4 } from 'uuid';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { attachUploadSettlement, relayWithRetry } from '~/utils/upload-settlement';

type TrackedFileStatus = 'pending' | 'error' | 'success' | 'uploading' | 'aborted' | 'blocked';
type TrackedFile = AsyncReturnType<typeof getDataFromFile> & {
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: TrackedFileStatus;
  abort: () => void;
  // id: string;
  url: string;
};

type UploadResult = {
  url: string;
  id: string;
  objectUrl: string;
  type: MediaType;
};

type UploadToCF = (
  file: File,
  metadata?: Record<string, string>,
  options?: { allowAnimatedWebP?: boolean }
) => Promise<UploadResult>;

type UseS3UploadTools = {
  uploadToCF: UploadToCF;
  files: TrackedFile[];
  removeImage: (imageId: string) => void;
  resetFiles: VoidFunction;
};

type UseCFImageUpload = () => UseS3UploadTools;

const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending' as const,
  abort: () => undefined,
};

export const useCFImageUpload: UseCFImageUpload = () => {
  const currentUser = useCurrentUser();
  const [files, setFiles] = useState<TrackedFile[]>([]);

  const resetFiles = () => {
    setFiles([]);
  };

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToCF: UploadToCF = async (file, metadata = {}, options) => {
    const imageData = await getDataFromFile(file, {
      allowAnimatedWebP: options?.allowAnimatedWebP ?? currentUser?.isModerator,
    });
    if (!imageData) throw new Error('Failed to process file before upload');

    const filename = encodeURIComponent(file.name);
    const res = await fetch('/api/v1/image-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename, metadata }),
    });

    const data: ImageUploadResponse = await res.json();

    if ('error' in data) {
      console.error(data.error);
      throw new Error(typeof data.error === 'string' ? data.error : 'image-upload API error');
    }

    const { id, uploadURL: url } = data;

    // The relay fallback (below) mints its OWN key server-side, so the id this call
    // resolves with is not necessarily the one the presign handed us. Everything that
    // reports an id — the tracked file's `url`, the return value — reads this, not the
    // `id` const, so a fallback upload is reported under the key that actually holds
    // the bytes.
    let resolvedId = id;

    const xhr = new XMLHttpRequest();

    // The relay is a `fetch`, not the xhr, so `xhr.abort()` is a spec no-op once the
    // xhr is DONE. Cancelling during a fallback has to cancel this instead.
    const relayController = new AbortController();

    setFiles((x) => [
      ...x,
      {
        ...pendingTrackedFile,
        ...imageData,
        abort: () => {
          xhr.abort();
          relayController.abort();
        },
        url: resolvedId,
      },
    ]);

    function updateFile(trackedFile: Partial<TrackedFile>) {
      setFiles((x) =>
        x.map((y) => {
          if (y.file !== file) return y;
          return {
            ...y,
            ...trackedFile,
            url: resolvedId,
          } as TrackedFile;
        })
      );
    }

    /**
     * Relay the file through our own origin when the direct PUT cannot reach the
     * storage host at all.
     *
     * Scoped deliberately to the `error` event, which is the network-layer failure —
     * DNS, TLS, connection refused. A non-2xx `loadend` is NOT retried here: that
     * means we reached the storage backend and it rejected us, and replaying the same
     * bytes through a second route would mask a real fault rather than route around
     * an unreachable host.
     */
    async function postToRelay(signal: AbortSignal) {
      return fetch('/api/v1/image-upload/relay', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
        signal,
      });
    }

    async function relayUpload(signal: AbortSignal) {
      // Retry-on-429 lives in `relayWithRetry` so it can be tested; see its comment
      // for why a shed must not be terminal.
      const relayRes = await relayWithRetry(() => postToRelay(signal), {
        signal,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        defaultRetryAfterSeconds: 2,
      });

      if (!relayRes.ok) throw new Error(`Upload fallback failed (status ${relayRes.status})`);
      const relayData: { id?: string; error?: unknown } = await relayRes.json();
      if (!relayData.id) throw new Error('Upload fallback returned no id');
      return relayData.id;
    }

    await new Promise((resolve, reject) => {
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

          updateFile({
            uploaded,
            size,
            progress,
            timeRemaining,
            speed,
            status: 'uploading',
          });
        }
      });
      // Terminal-event handling — including the relay fallback and which side is
      // allowed to settle — lives in `attachUploadSettlement`, so the ordering rule
      // is real code a unit test can drive rather than logic duplicated in a test.
      attachUploadSettlement(xhr, () => relayUpload(relayController.signal), {
        onRelayed: (relayedId) => {
          resolvedId = relayedId;
        },
        onSuccess: () => updateFile({ status: 'success' }),
        onError: () => updateFile({ status: 'error' }),
        onAborted: () => updateFile({ status: 'aborted' }),
      }).then(
        (outcome) => resolve(outcome.kind === 'relayed' ? true : outcome.success),
        (error) => reject(error)
      );

      xhr.open('PUT', url);
      xhr.send(file);
    });

    return {
      url: url.split('?')[0],
      id: resolvedId,
      objectUrl: imageData.objectUrl,
      type: imageData.type,
    };
  };

  const removeImage = (imageUrl: string) => {
    setFiles((current) => current.filter((x) => x.url !== imageUrl));
  };

  return {
    uploadToCF,
    files,
    resetFiles,
    removeImage,
  };
};

export type DataFromFile = AsyncReturnType<typeof getDataFromFile>;
export const getDataFromFile = async (file: File, options?: { allowAnimatedWebP?: boolean }) => {
  const processed = await preprocessFile(file, options);
  const { blockedFor } = await auditImageMeta(
    processed.type === MediaType.image ? processed.meta : undefined,
    false
  );
  if (processed.type === 'video') {
    const { metadata } = processed;
    try {
      if (metadata.duration && metadata.duration > constants.mediaUpload.maxVideoDurationSeconds)
        throw new Error(
          `Video duration cannot be longer than ${constants.mediaUpload.maxVideoDurationSeconds} seconds. Please trim your video and try again.`
        );
      if (
        metadata.width > constants.mediaUpload.maxVideoDimension ||
        metadata.height > constants.mediaUpload.maxVideoDimension
      )
        throw new Error(
          `Images cannot be larger than ${constants.mediaUpload.maxVideoDimension}px from either side. Please resize your image or video and try again.`
        );
    } catch (error: any) {
      showErrorNotification({ error });
      return null;
    }
  }

  if (processed.type === 'image' && processed.meta.comfy) {
    const { comfy } = processed.meta;
    // if comfy metadata is larger than 1MB, we don't want to store it
    const tooLarge = calculateSizeInMegabytes(comfy) > 1;
    try {
      if (tooLarge)
        throw new Error('Comfy metadata is too large. Please consider updating your workflow');
    } catch (e) {
      const error = e as Error;
      showErrorNotification({ title: 'Unable to parse image metadata', error });
      return null;
    }
  }

  const { height, width, hash } = processed.metadata;

  return {
    file,
    uuid: uuidv4(),
    status: blockedFor ? ('blocked' as TrackedFileStatus) : ('uploading' as TrackedFileStatus),
    message: blockedFor?.filter(isDefined).join(', '),
    height,
    width,
    hash,
    ...processed,
    url: processed.objectUrl,
  };
};
