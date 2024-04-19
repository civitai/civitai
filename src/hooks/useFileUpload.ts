import { useEffect, useState } from 'react';
import { produce } from 'immer';
import plimit from 'p-limit';
import { useFileUploadContext, TrackedFile } from '~/components/FileUpload/FileUploadProvider';

const pendingProcessing: TrackedFile['status'][] = ['pending', 'uploading'];
const maxConcurrency = 5;
const concurrency = typeof navigator !== 'undefined' ? navigator?.hardwareConcurrency ?? 1 : 1;
const limit = plimit(Math.min(maxConcurrency, concurrency));

export function useFileUpload() {
  const state = useState<TrackedFile[]>([]);
  const fileUploadContext = useFileUploadContext();
  const [files, setFiles] = fileUploadContext ?? state;

  async function upload(file: File) {
    setFiles(
      produce((state) => {
        state.push({
          progress: 0,
          uploaded: 0,
          size: 0,
          speed: 0,
          timeRemaining: 0,
          status: 'pending',
          abort: () => undefined,
          url: '',
          file,
        });
      })
    );

    return limit(async () => {
      const res = await fetch('/api/image-upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const data: ImageUploadResponse = await res.json();

      if ('error' in data) {
        console.error(data.error);
        throw data.error;
      }

      const { id, uploadURL } = data;

      const xhr = new XMLHttpRequest();
      setFiles(
        produce((state) => {
          const index = state.findIndex((x) => x.file === file);
          state[index].abort = xhr.abort.bind(xhr);
          state[index].url = id;
        })
      );

      function updateTrackedFile(trackedFile: Partial<TrackedFile>) {
        setFiles(
          produce((state) => {
            const index = state.findIndex((x) => x.url === id);
            if (index > -1) state[index] = { ...state[index], ...trackedFile, url: id };
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

            updateTrackedFile({
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
            updateTrackedFile({ status: 'success' });
          }
          resolve(success);
        });
        xhr.addEventListener('error', () => {
          updateTrackedFile({ status: 'error' });
          resolve('upload error');
        });
        xhr.addEventListener('abort', () => {
          setFiles((state) => state.filter((x) => x.url !== id));
          resolve(false);
        });
        xhr.open('PUT', uploadURL);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
      });

      return data;
    });
  }

  function reset(abort?: boolean) {
    if (abort) {
      const toAbort = files.filter((x) => pendingProcessing.includes(x.status));
      for (const item of toAbort) item.abort();
    }
    setFiles([]);
  }

  function removeFile(url: string, abort?: boolean) {
    if (abort) {
      const toAbort = files.find((x) => x.url === url);
      if (toAbort) toAbort.abort();
    }
    setFiles((state) => state.filter((x) => x.url !== url));
  }

  useEffect(() => {
    if (!fileUploadContext) {
      return () => {
        reset(true);
      };
    }
  }, []); // eslint-disable-line

  return { files, upload, reset, removeFile };
}
