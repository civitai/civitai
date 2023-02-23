import { UploadType } from '~/server/common/enums';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type UploadResult = {
  url: string;
  bucket: string;
  key: string;
};

type RequestOptions = {
  body: MixedObject;
  headers: HeadersInit;
};

type EndpointOptions = {
  request: RequestOptions;
};

type UploadToS3Options = {
  endpoint?: EndpointOptions;
};

type UseS3UploadOptions = {
  endpoint?: string;
  endpointComplete?: string;
};

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

type UploadStatus = 'pending' | 'error' | 'success' | 'aborted';

type StoreProps = {
  files: TrackedFile[];
  upload: (file: File, type: UploadType, options?: UploadToS3Options) => Promise<UploadResult>;
  reset: () => void;
  getStatus: () => {
    pending: number;
    error: number;
    uploading: number;
    success: number;
    aborted: number;
  };
};

export const useFileUpload = create<StoreProps>()(
  immer((set, get) => ({
    files: [],
    reset: () => {
      set((state) => {
        state.files = [];
      });
    },
    getStatus: () => {
      const files = get().files;
      return {
        pending: files.filter((x) => x.status === 'pending').length,
        error: files.filter((x) => x.status === 'error').length,
        uploading: files.filter((x) => x.status === 'uploading').length,
        success: files.filter((x) => x.status === 'success').length,
        aborted: files.filter((x) => x.status === 'aborted').length,
      };
    },
    upload: async (file, type, options) => {
      const endpoint = '/api/upload';
      const completeEndpoint = '/api/upload/complete';
      const abortEndpoint = '/api/upload/abort';

      const filename = encodeURIComponent(file.name);

      const requestExtras = options?.endpoint?.request ?? {
        headers: {},
        body: {},
      };

      const { size } = file;
      const body = {
        filename,
        type,
        size,
        ...requestExtras.body,
      };

      const headers = {
        ...requestExtras.headers,
        'Content-Type': 'application/json',
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (data.error) {
        console.error(data.error);
        throw data.error;
      } else {
        const { bucket, key, uploadId, urls } = data;

        let currentXhr: XMLHttpRequest;
        const abort = () => {
          if (currentXhr) currentXhr.abort();
        };

        set((state) => {
          state.files.push({ file, ...pendingTrackedFile, abort } as TrackedFile);
        });

        function updateFile(trackedFile: Partial<TrackedFile>) {
          set((state) => {
            state.files = state.files.map((x) => {
              if (x.file !== file) return x;
              return { ...x, ...trackedFile } as TrackedFile;
            });
          });
        }

        // Upload tracking
        const uploadStart = Date.now();
        let totalUploaded = 0;
        const updateProgress = ({ loaded }: ProgressEvent) => {
          const uploaded = totalUploaded + (loaded ?? 0);
          if (uploaded) {
            const secondsElapsed = (Date.now() - uploadStart) / 1000;
            const speed = uploaded / secondsElapsed;
            const timeRemaining = (size - uploaded) / speed;
            const progress = size ? (uploaded / size) * 100 : 0;
            updateFile({
              progress,
              uploaded,
              size,
              speed,
              timeRemaining,
              status: 'uploading',
            });
          }
        };

        // Prepare abort
        const abortUpload = () =>
          fetch(abortEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              key,
              type,
              uploadId,
            }),
          });

        const completeUpload = () =>
          fetch(completeEndpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              key,
              type,
              uploadId,
              parts,
            }),
          });

        // Prepare part upload
        const partsCount = urls.length;
        const uploadPart = (url: string, i: number) =>
          new Promise<UploadStatus>((resolve) => {
            let eTag: string;
            const start = (i - 1) * FILE_CHUNK_SIZE;
            const end = i * FILE_CHUNK_SIZE;
            const part = i === partsCount ? file.slice(start) : file.slice(start, end);
            const xhr = new XMLHttpRequest();
            xhr.upload.addEventListener('progress', updateProgress);
            xhr.upload.addEventListener('loadend', ({ loaded }) => {
              totalUploaded += loaded;
            });
            xhr.addEventListener('loadend', () => {
              const success = xhr.readyState === 4 && xhr.status === 200;
              if (success) {
                parts.push({ ETag: eTag, PartNumber: i });
                resolve('success');
              }
            });
            xhr.addEventListener('load', () => {
              eTag = xhr.getResponseHeader('ETag') ?? '';
            });
            xhr.addEventListener('error', () => resolve('error'));
            xhr.addEventListener('abort', () => resolve('aborted'));
            xhr.open('PUT', url);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.send(part);
            currentXhr = xhr;
          });

        // Make part requests
        const parts: { ETag: string; PartNumber: number }[] = [];
        for (const { url, partNumber } of urls as { url: string; partNumber: number }[]) {
          let uploadStatus: UploadStatus = 'pending';

          // Retry up to 3 times
          let retryCount = 0;
          while (retryCount < 3) {
            uploadStatus = await uploadPart(url, partNumber);
            if (uploadStatus !== 'error') break;
            retryCount++;
            await new Promise((resolve) => setTimeout(resolve, 5000 * retryCount));
          }

          // If we failed to upload, abort the whole thing
          if (uploadStatus !== 'success') {
            updateFile({ status: uploadStatus, file: undefined });
            await abortUpload();
            return { url: null, bucket, key };
          }
        }

        // Complete the multipart upload
        await completeUpload();
        await updateFile({ status: 'success' });

        const url = urls[0].url.split('?')[0];
        return { url, bucket, key };
      }
    },
  }))
);

const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB
const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
};
