import { useState } from 'react';

type TrackedFile = {
  file: File;
  progress: number;
  uploaded: number;
  size: number;
  speed: number;
  timeRemaining: number;
  status: 'pending' | 'error' | 'success' | 'uploading' | 'aborted';
  abort: () => void;
};

type UploadResult = {
  url: string;
  id: string;
};

type UploadToCF = (file: File, metadata?: Record<string, string>) => Promise<UploadResult>;

type UseS3UploadTools = {
  uploadToCF: UploadToCF;
  files: TrackedFile[];
};

type UseCFImageUpload = () => UseS3UploadTools;

const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
};

export const useCFImageUpload: UseCFImageUpload = () => {
  const [files, setFiles] = useState<TrackedFile[]>([]);

  const resetFiles = () => {
    setFiles([]);
  };

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToCF: UploadToCF = async (file, metadata = {}) => {
    const filename = encodeURIComponent(file.name);
    const res = await fetch('/api/image-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ filename, metadata }),
    });

    const data = await res.json();

    if (data.error) {
      console.error(data.error);
      throw data.error;
    }

    const { id, uploadURL: url } = data;

    const xhr = new XMLHttpRequest();
    setFiles((x) => [
      ...x,
      { file, ...pendingTrackedFile, abort: xhr.abort.bind(xhr) } as TrackedFile,
    ]);

    function updateFile(trackedFile: Partial<TrackedFile>) {
      setFiles((x) =>
        x.map((y) => {
          if (y.file !== file) return y;
          return { ...y, ...trackedFile } as TrackedFile;
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
        if (success) updateFile({ status: 'success' });
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
      xhr.open('POST', url, true);
      const formData = new FormData();
      formData.append('file', file);
      xhr.send(formData);
    });

    return { url: url.split('?')[0], id };
  };

  return {
    uploadToCF,
    files,
    resetFiles,
  };
};
