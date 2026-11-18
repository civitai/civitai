import { useCallback, useState } from 'react';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import { trpc } from '~/utils/trpc';

export const SEARCH_UPLOAD_FAILED_MESSAGE = "This image can't be used for search.";
const STATUS_POLL_MS = 1_500;

type UploadState =
  | { step: 'idle' }
  | { step: 'uploading' }
  | { step: 'checking'; uploadId: number }
  | { step: 'error'; message: string };

/** Upload a file, then poll its scan until the server says it can be searched from, or not. */
export function useImageSearchUpload() {
  const [state, setState] = useState<UploadState>({ step: 'idle' });
  const prepare = trpc.imageSearchUpload.prepare.useMutation();
  const uploadId = state.step === 'checking' ? state.uploadId : undefined;
  const status = trpc.imageSearchUpload.status.useQuery(
    { uploadId: uploadId ?? 0 },
    {
      enabled: uploadId !== undefined,
      refetchInterval: (query) =>
        query.state.data?.status === 'pending' && !query.state.error ? STATUS_POLL_MS : false,
      gcTime: 0,
      staleTime: 0,
    }
  );

  const start = useCallback(
    async (file: File) => {
      setState({ step: 'uploading' });
      try {
        const blob = await uploadConsumerBlob(file);
        if (!blob.url) throw new Error(SEARCH_UPLOAD_FAILED_MESSAGE);
        const { uploadId } = await prepare.mutateAsync({ url: blob.url });
        setState({ step: 'checking', uploadId });
      } catch (error) {
        setState({
          step: 'error',
          message: error instanceof Error ? error.message : SEARCH_UPLOAD_FAILED_MESSAGE,
        });
      }
    },
    [prepare]
  );

  const reset = useCallback(() => setState({ step: 'idle' }), []);

  const verdict = status.data?.status;
  return {
    start,
    reset,
    uploading: state.step === 'uploading',
    checking: state.step === 'checking' && (!verdict || verdict === 'pending') && !status.error,
    readyUploadId: verdict === 'ready' ? uploadId : undefined,
    error:
      state.step === 'error'
        ? state.message
        : verdict === 'refused'
        ? status.data?.message ?? SEARCH_UPLOAD_FAILED_MESSAGE
        : status.error?.message,
  };
}
