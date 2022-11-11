import React, { ChangeEvent, ReactElement, useRef, useState, forwardRef } from 'react';
import { UploadType, UploadTypeUnion } from '~/server/common/enums';

type FileInputProps = {
  onChange: (file: File[] | undefined, event: ChangeEvent<HTMLInputElement>) => void;
  [index: string]: any; // Indexer to spread props
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
};

type UploadResult = {
  url: string;
  bucket: string;
  key: string;
};

type RequestOptions = {
  body: Record<string, any>;
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
  FileInput: (props: any) => ReactElement<HTMLInputElement>;
  openFileDialog: () => void;
  uploadToS3: UploadToS3;
  files: TrackedFile[];
  resetFiles: () => void;
};

type UseS3Upload = (options?: UseS3UploadOptions) => UseS3UploadTools;

const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => {},
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

  const endpoint = options.endpoint ?? '/api/s3-upload';

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToS3: UploadToS3 = async (file, type = UploadType.Default, options = {}) => {
    const filename = encodeURIComponent(file.name);

    const requestExtras = options?.endpoint?.request ?? {
      headers: {},
      body: {},
    };

    const body = {
      filename,
      type,
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
      const { url, bucket, key } = data;

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
        xhr.upload.addEventListener('loadstart', (e) => {
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
        xhr.addEventListener('loadend', ({ loaded, total }) => {
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
        xhr.open('PUT', url, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.send(file);
      });

      return { url: url.split('?')[0], bucket, key };
    }
  };

  return {
    FileInput: (props: any) => <FileInput {...props} ref={ref} style={{ display: 'none' }} />,
    openFileDialog,
    uploadToS3,
    files,
    resetFiles,
  };
};
