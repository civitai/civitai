import React, { ChangeEvent, ReactElement, useRef, useState, forwardRef } from 'react';
import { UploadType, UploadTypeUnion } from '~/server/common/enums';

const FILE_CHUNK_SIZE = 100 * 1024 * 1024; // 100 MB

type FileInputProps = {
  onChange: (file: File[] | undefined, event: ChangeEvent<HTMLInputElement>) => void;
  [index: string]: any; //eslint-disable-line
};

// eslint-disable-next-line react/display-name
const FileInput = forwardRef<HTMLInputElement, FileInputProps>(
  ({ onChange, ...restOfProps }, forwardedRef) => {
    const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(event.target?.files ?? []);
      onChange?.(files, event);
    };

    return <input onChange={handleChange} {...restOfProps} ref={forwardedRef} type="file" />;
  }
);

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

type UseS3UploadOptions = {
  endpoint?: string;
  endpointComplete?: string;
};

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

type UploadToS3 = (
  file: File,
  type?: UploadType | UploadTypeUnion,
  options?: UploadToS3Options
) => Promise<UploadResult>;

type UseS3UploadTools = {
  FileInput: (props: any) => ReactElement<HTMLInputElement>; //eslint-disable-line
  openFileDialog: () => void;
  uploadToS3: UploadToS3;
  files: TrackedFile[];
  resetFiles: () => void;
};

type UseS3Upload = (options?: UseS3UploadOptions) => UseS3UploadTools;

type UploadStatus = 'pending' | 'error' | 'success' | 'aborted';

const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
};

export const useS3Upload: UseS3Upload = (options = {}) => {
  const ref = useRef<HTMLInputElement>();
  const [files, setFiles] = useState<TrackedFile[]>([]);

  const openFileDialog = () => {
    if (ref.current) {
      ref.current.value = '';
      ref.current?.click();
    }
  };

  const resetFiles = () => {
    setFiles([]);
  };

  const endpoint = options.endpoint ?? '/api/upload';
  const completeEndpoint = options.endpointComplete ?? '/api/upload/complete';
  const abortEndpoint = options.endpointComplete ?? '/api/upload/abort';

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToS3: UploadToS3 = async (file, type = UploadType.Default, options = {}) => {
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
      setFiles((x) => [...x, { file, ...pendingTrackedFile, abort } as TrackedFile]);

      function updateFile(trackedFile: Partial<TrackedFile>) {
        setFiles((x) =>
          x.map((y) => {
            if (y.file !== file) return y;
            return { ...y, ...trackedFile } as TrackedFile;
          })
        );
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
  };

  return {
    FileInput: (props: any) => <FileInput {...props} ref={ref} style={{ display: 'none' }} />, //eslint-disable-line
    openFileDialog,
    uploadToS3,
    files,
    resetFiles,
  };
};
