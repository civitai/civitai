import { FileUpload, FileUploadOptions } from '~/utils/file-upload/file-upload';
import { Queue } from '~/utils/queue';

type UploadStatus = 'pending' | 'error' | 'success' | 'aborted';
type UploadOptions = FileUploadOptions;
type ApiUploadResponse = {
  urls: Array<{ url: string; partNumber: number }>;
  bucket: string;
  key: string;
  uploadId?: string;
};

const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB

export function createMultipartUpload({
  endpoint,
  completeEndpoint,
  abortEndpoint,
}: {
  endpoint: string;
  completeEndpoint: string;
  abortEndpoint: string;
}) {
  const queue = new Queue();
  return async (file: File, type?: any, options?: UploadOptions) => {
    const { onComplete, onProgress, onError, onAbort } = options ?? {};
    const fileUpload = new FileUpload(file, { onComplete, onProgress, onError, onAbort });
    const handleUpload = async () => {
      const size = file.size;
      const filename = encodeURIComponent(file.name);
      const headers = { 'Content-Type': 'application/json' };
      // TODO - figure out how we're using type
      const body = { filename, size, type };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.error) throw data.error;

      const { bucket, key, uploadId, urls } = data as ApiUploadResponse;

      const uploadStart = Date.now();
      const partsCount = urls.length;
      let totalUploaded = 0;

      const parts: { ETag: string; PartNumber: number }[] = [];
      const uploadPart = (url: string, i: number) =>
        new Promise<UploadStatus>((resolve) => {
          let eTag = '';
          const start = (i - 1) * FILE_CHUNK_SIZE;
          const end = i * FILE_CHUNK_SIZE;
          const part = i === partsCount ? file.slice(start) : file.slice(start, end);
          const xhr = new XMLHttpRequest();
          xhr.upload.addEventListener('progress', ({ loaded }) => {
            const uploaded = totalUploaded + (loaded ?? 0);
            if (uploaded) {
              const secondsElapsed = (Date.now() - uploadStart) / 1000;
              const speed = uploaded / secondsElapsed;
              const timeRemaining = (size - uploaded) / speed;
              const progress = size ? (uploaded / size) * 100 : 0;
              fileUpload.dispatch('progress', { progress, uploaded, size, speed, timeRemaining });
            }
          });
          xhr.upload.addEventListener('loadend', ({ loaded }) => {
            totalUploaded += loaded;
            const success = xhr.readyState === 4 && xhr.status === 200;
            if (success) {
              parts.push({ ETag: eTag, PartNumber: i });
              resolve('success');
            }
          });
          xhr.addEventListener('error', () => {
            fileUpload.dispatch('error', undefined);
            resolve('error');
          });
          xhr.addEventListener('abort', () => {
            fileUpload.dispatch('abort', undefined);
            resolve('aborted');
          });
          xhr.addEventListener('load', () => {
            eTag = xhr.getResponseHeader('ETag') ?? '';
          });
          xhr.open('PUT', url);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.send(part);
          fileUpload.abort = xhr.abort;
        });

      const abortUpload = () =>
        fetch(abortEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            bucket,
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
            bucket,
            key,
            type,
            uploadId,
            parts,
          }),
        });

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
          try {
            await abortUpload();
          } catch (err) {
            console.error('Failed to abort upload');
            console.error(err);
          }
          return;
        }
      }

      const completeResult = await completeUpload().catch((err) => {
        console.error('Failed to complete upload');
        console.error(err);
        fileUpload.dispatch('error', undefined);
        return { ok: false };
      });
      if (!completeResult.ok) return;

      const url = urls[0].url.split('?')[0];
      fileUpload.dispatch('complete', { url, bucket, key });
    };
    queue.enqueu(handleUpload);
    return fileUpload;
  };
}
