import { useState } from 'react';
import { getDataFromFile } from '~/utils/metadata';

type TrackedFile = AsyncReturnType<typeof getDataFromFile> & {
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: 'pending' | 'error' | 'success' | 'uploading' | 'aborted' | 'blocked';
  abort: () => void;
  // id: string;
  url: string;
};

type UploadResult = {
  url: string;
  id: string;
  objectUrl: string;
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
    const res = await fetch('/api/image-upload', {
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

    await new Promise((resolve) => {
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
        resolve(false);
      });
      xhr.addEventListener('abort', () => {
        updateFile({ status: 'aborted' });
        resolve(false);
      });
      xhr.open('PUT', url);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(file);
    });

    return { url: url.split('?')[0], id, objectUrl: imageData.objectUrl };
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
