import { useEffect, useState } from 'react';
import {
  CustomProgressEvent,
  FileUpload,
  FileUploadOptions,
  UploadCompleteEvent,
} from '~/utils/file-upload/file-upload';

/* THIS IS A WORK IN PROGRESS */

export function useFileUploadEvents(fileUpload: FileUpload, options?: FileUploadOptions) {
  const { onProgress, onComplete, onError, onAbort } = options ?? {};
  const [status, setStatus] = useState<'error' | 'abort' | 'complete'>();
  const [progress, setProgress] = useState({
    progress: 0,
    uploaded: 0,
    size: 0,
    speed: 0,
    timeRemaining: 0,
  });

  useEffect(() => {
    const handleProgress = ({ detail }: CustomEvent<CustomProgressEvent>) => {
      setProgress(detail);
      onProgress?.(detail);
    };
    const handleComplete = ({ detail }: CustomEvent<UploadCompleteEvent>) => {
      setStatus('complete');
      onComplete?.(detail);
    };
    const handleError = () => {
      setStatus('error');
      onError?.();
    };
    const handleAbort = () => {
      setStatus('abort');
      onAbort?.();
    };

    fileUpload.on('progress', handleProgress);
    fileUpload.on('complete', handleComplete);
    fileUpload.on('error', handleError);
    fileUpload.on('abort', handleAbort);

    return () => {
      fileUpload.off('progress', handleProgress);
      fileUpload.off('complete', handleComplete);
      fileUpload.off('error', handleError);
      fileUpload.off('abort', handleAbort);
    };
  }, [fileUpload]); // eslint-disable-line

  return { ...progress, status };
}
