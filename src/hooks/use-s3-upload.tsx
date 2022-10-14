import React, { ChangeEvent, ReactElement, useRef, useState, forwardRef } from 'react';
import { CompleteMultipartUploadCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

type FileInputProps = {
  onChange: (file: File | undefined, event: ChangeEvent<HTMLInputElement>) => void;
  [index: string]: any; // Indexer to spread props
};

// eslint-disable-next-line react/display-name
const FileInput = forwardRef<HTMLInputElement, FileInputProps>(
  ({ onChange = () => {}, ...restOfProps }, forwardedRef) => {
    const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
      const file = event.target?.files?.[0];
      onChange(file, event);
    };

    return <input onChange={handleChange} {...restOfProps} ref={forwardedRef} type="file" />;
  }
);

type TrackedFile = {
  file: File;
  progress: number;
  uploaded: number;
  size: number;
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

type UploadToS3 = (file: File, options?: UploadToS3Options) => Promise<UploadResult>;

type UseS3UploadTools = {
  FileInput: (props: any) => ReactElement<HTMLInputElement>;
  openFileDialog: () => void;
  uploadToS3: UploadToS3;
  files: TrackedFile[];
  resetFiles: () => void;
};

type UseS3Upload = (options?: UseS3UploadOptions) => UseS3UploadTools;

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
  const uploadToS3: UploadToS3 = async (file, options = {}) => {
    const filename = encodeURIComponent(file.name);

    const requestExtras = options?.endpoint?.request ?? {
      headers: {},
      body: {},
    };

    const body = {
      filename,
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
      const client = new S3Client({
        credentials: {
          accessKeyId: data.token.Credentials.AccessKeyId,
          secretAccessKey: data.token.Credentials.SecretAccessKey,
          sessionToken: data.token.Credentials.SessionToken,
        },
        region: data.region,
        endpoint: data.endpoint,
      });

      const params = {
        Bucket: data.bucket,
        Key: data.key,
        Body: file,
        CacheControl: 'max-age=630720000, public',
        ContentType: file.type,
      };

      // at some point make this configurable
      // let uploadOptions = {
      //   partSize: 100 * 1024 * 1024,
      //   queueSize: 1,
      // };

      const s3Upload = new Upload({
        client,
        params,
      });

      setFiles((x) => [...x, { file, progress: 0, uploaded: 0, size: file.size }]);

      s3Upload.on('httpUploadProgress', (progress) => {
        const uploaded = progress.loaded ?? 0;
        const size = progress.total ?? 0;

        if (uploaded) {
          setFiles((x) =>
            x.map((trackedFile) =>
              trackedFile.file === file
                ? {
                    file,
                    uploaded,
                    size,
                    progress: size ? (uploaded / size) * 100 : 0,
                  }
                : trackedFile
            )
          );
        }
      });

      const uploadResult = (await s3Upload.done()) as CompleteMultipartUploadCommandOutput;

      return {
        url: uploadResult.Location ?? '',
        bucket: uploadResult.Bucket ?? '',
        key: uploadResult.Key ?? '',
      };
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
