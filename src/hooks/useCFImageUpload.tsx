import { useState } from 'react';
import { constants } from '~/server/common/constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { auditImageMeta, preprocessFile } from '~/utils/media-preprocessors';
import { showErrorNotification } from '~/utils/notifications';
import { isDefined } from '~/utils/type-guards';
import { v4 as uuidv4 } from 'uuid';

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

type UploadToCF = (file: File, metadata?: Record<string, string>) => Promise<UploadResult>;

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
  const [files, setFiles] = useState<TrackedFile[]>([]);

  const resetFiles = () => {
    setFiles([]);
  };

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToCF: UploadToCF = async (file, metadata = {}) => {
    const imageData = await getDataFromFile(file);
    if (!imageData) throw new Error();

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
      throw data.error;
    }

    const { id, uploadURL: url } = data;

    const xhr = new XMLHttpRequest();
    setFiles((x) => [
      ...x,
      {
        ...pendingTrackedFile,
        ...imageData,
        abort: xhr.abort.bind(xhr),
        url: id,
      },
    ]);

    function updateFile(trackedFile: Partial<TrackedFile>) {
      setFiles((x) =>
        x.map((y) => {
          if (y.file !== file) return y;
          return {
            ...y,
            ...trackedFile,
            url: id,
          } as TrackedFile;
        })
      );
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
      xhr.addEventListener('loadend', () => {
        const success = xhr.readyState === 4 && xhr.status === 200;
        if (success) {
          updateFile({ status: 'success' });
          // URL.revokeObjectURL(imageData.objectUrl);
        }
        resolve(success);
      });
      xhr.addEventListener('error', () => {
        updateFile({ status: 'error' });
        reject(false);
      });
      xhr.addEventListener('abort', () => {
        updateFile({ status: 'aborted' });
        reject(false);
      });
      xhr.open('PUT', url);
      xhr.send(file);
    });

    return { url: url.split('?')[0], id, objectUrl: imageData.objectUrl, type: imageData.type };
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
export const getDataFromFile = async (file: File) => {
  const processed = await preprocessFile(file);
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
