import type { ChangeEvent, ReactElement } from 'react';
import React, { forwardRef, useRef, useState } from 'react';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { useFileUploadContext } from '~/components/FileUpload/FileUploadProvider';
import type { UploadTypeUnion } from '~/server/common/enums';
import { UploadType } from '~/server/common/enums';
import type { MultipartRequestOptions } from '~/utils/multipart-upload';
import { startMultipartUpload } from '~/utils/multipart-upload';
import { abortableSleep } from '~/utils/errorHandling';
import {
  describePartFailure,
  resolveUploadRowStatus,
  selectRelayFallback,
} from '~/utils/upload-retry';
import { relayImageChunkedFallback, relayImageFallback } from '~/utils/upload-settlement';
import type { ClientDeclarableRelayFallbackOutcome } from '~/utils/relay-fallback-outcome';

type FileInputProps = {
  onChange: (file: File[] | undefined, event: ChangeEvent<HTMLInputElement>) => void;
  [index: string]: any; //eslint-disable-line
};

// eslint-disable-next-line react/display-name
const CivFileInput = forwardRef<HTMLInputElement, FileInputProps>(
  ({ onChange, ...restOfProps }, forwardedRef) => {
    const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
      const files = Array.from(event.target?.files ?? []);
      onChange?.(files, event);
    };

    return <input onChange={handleChange} {...restOfProps} ref={forwardedRef} type="file" />;
  }
);

type UseS3UploadOptions = {
  endpoint?: string;
};

type UploadResult = {
  url: string | null;
  bucket: string;
  key: string;
  name?: string;
  size?: number;
  backend?: string;
};

type UploadToS3 = (
  file: File,
  type?: UploadType | UploadTypeUnion,
  options?: MultipartRequestOptions
) => Promise<UploadResult>;

type UseS3UploadTools = {
  FileInput: (props: any) => ReactElement<HTMLInputElement>; //eslint-disable-line
  openFileDialog: () => void;
  uploadToS3: UploadToS3;
  files: TrackedFile[];
  resetFiles: () => void;
  removeFile: (file: File, abort?: boolean) => void;
};

type UseS3Upload = (options?: UseS3UploadOptions) => UseS3UploadTools;

const pendingTrackedFile = {
  progress: 0,
  uploaded: 0,
  size: 0,
  speed: 0,
  timeRemaining: 0,
  status: 'pending',
  abort: () => undefined,
  name: '',
  url: '',
};

export const useS3Upload: UseS3Upload = (options = {}) => {
  const ref = useRef<HTMLInputElement>();
  const state = useState<TrackedFile[]>([]);
  const fileUploadContext = useFileUploadContext();
  const [files, setFiles] = fileUploadContext ?? state;

  const openFileDialog = () => {
    if (ref.current) {
      ref.current.value = '';
      ref.current?.click();
    }
  };

  const resetFiles = () => {
    setFiles([]);
  };

  function removeFile(file: File, abort?: boolean) {
    if (abort) {
      const toAbort = files.find((x) => x.file === file);
      if (toAbort) toAbort.abort();
    }
    setFiles((state) => state.filter((x) => x.file !== file));
  }

  const endpoint = options.endpoint ?? '/api/upload';

  // eslint-disable-next-line @typescript-eslint/no-shadow
  const uploadToS3: UploadToS3 = async (file, type = UploadType.Default, options = {}) => {
    const upload = await startMultipartUpload({ file, type, endpoint, options });
    const { bucket, key, backend } = upload;
    const { size } = file;

    // The only user-initiated cancel. `UploadItem` gets it via the `{...file}` spread, so its call
    // site never mentions it. `FileUploadProvider`'s unmount effect closes over the first render's
    // empty `files`, so it aborts nothing.
    const userAbortController = new AbortController();
    const abort = () => userAbortController.abort();
    setFiles((x) => {
      if (x.some((y) => y.file === file)) {
        return x.map((y) => (y.file === file ? ({ ...y, abort } as TrackedFile) : y));
      }
      return [...x, { file, ...pendingTrackedFile, abort } as TrackedFile];
    });

    function updateFile(trackedFile: Partial<TrackedFile>) {
      setFiles((x) =>
        x.map((y) => {
          if (y.file !== file) return y;
          return { ...y, ...trackedFile } as TrackedFile;
        })
      );
    }

    const fatal = await upload.transferParts({
      signal: userAbortController.signal,
      onProgress: (progress) => updateFile({ ...progress, status: 'uploading', name: file.name }),
    });

    if (fatal) {
      // The relayed upload has the RELAY-MINTED key, not the one the multipart session was opened
      // with: the endpoint accepts no caller key. `not_attempted` is the gate declining, distinct
      // from a relay that ran and failed.
      let relayOutcome: ClientDeclarableRelayFallbackOutcome = 'not_attempted';

      const relayRoute = selectRelayFallback(fatal, {
        type,
        backend,
        fileSize: size,
        userAborted: userAbortController.signal.aborted,
      });
      if (relayRoute) {
        const relayOpts = {
          signal: userAbortController.signal,
          sleep: (ms: number) => abortableSleep(ms, userAbortController.signal),
          defaultRetryAfterSeconds: 2,
        };
        const relayed =
          relayRoute === 'chunked'
            ? await relayImageChunkedFallback(file, {
                ...relayOpts,
                onProgress: (sent) =>
                  updateFile({
                    progress: (sent / size) * 100,
                    uploaded: sent,
                    size,
                    status: 'uploading',
                    name: file.name,
                  }),
              })
            : await relayImageFallback(file, relayOpts);
        relayOutcome = relayed.ok ? 'rescued' : relayed.reason;
        if (relayed.ok) {
          // 🔴 `progress` MUST be written here: a network-layer failure fires little or no
          // `upload.progress`, and `useMediaUpload` clears finished rows only when EVERY tracked file
          // reads 100, so one relayed row left below 100 pins the upload UI open for later uploads too.
          updateFile({
            status: 'success',
            progress: 100,
            uploaded: size,
            size,
            speed: 0,
            timeRemaining: 0,
          });
          // The multipart session is now orphaned (its key holds no bytes) — tear it
          // down, after the success write so a teardown failure cannot mask the outcome.
          await upload.abort(describePartFailure(fatal), relayOutcome);
          return { url: relayed.id, bucket, key: relayed.id, name: file.name, size, backend };
        }
      }

      const status: TrackedFile['status'] = resolveUploadRowStatus(fatal, {
        userAborted: userAbortController.signal.aborted,
      });
      updateFile({ status, file: undefined });
      await upload.abort(describePartFailure(fatal), relayOutcome);
      return { url: null, bucket, key, backend };
    }

    const resp = await upload.complete();
    // this can happen with a 0-byte file, among other things
    if (!resp?.ok) {
      updateFile({ status: 'error', file: undefined });
      await upload.abort();
      return { url: null, bucket, key, backend };
    }

    updateFile({ status: 'success' });
    return { url: upload.url, bucket, key, name: file.name, size: file.size, backend };
  };

  return {
    FileInput: (props: any) => <CivFileInput {...props} ref={ref} style={{ display: 'none' }} />, //eslint-disable-line
    openFileDialog,
    uploadToS3,
    files,
    resetFiles,
    removeFile,
  };
};
