import { useCallback, useState } from 'react';
import { uploadConsumerBlob } from '~/utils/consumer-blob-upload';
import type { SearchUploadSource } from '~/server/schema/semantic-image-search.schema';
import { trpc } from '~/utils/trpc';

export const SEARCH_UPLOAD_FAILED_MESSAGE = "This image can't be used for search.";
const STATUS_POLL_MS = 1_500;

type UploadState =
  | { step: 'idle' }
  | { step: 'uploading' }
  | { step: 'checking'; uploadId: string; url: string }
  | { step: 'error'; message: string };

/** Upload a file, then poll its scan until the server says it can be searched from, or not. */
export function useImageSearchUpload() {
  const [state, setState] = useState<UploadState>({ step: 'idle' });
  const prepare = trpc.imageSearchUpload.prepare.useMutation();
  const checking = state.step === 'checking' ? state : undefined;
  const uploadId = checking?.uploadId;
  const status = trpc.imageSearchUpload.status.useQuery(
    { uploadId: uploadId ?? '' },
    {
      enabled: uploadId !== undefined,
      refetchInterval: (query) =>
        query.state.data?.status === 'pending' && !query.state.error ? STATUS_POLL_MS : false,
      gcTime: 0,
      staleTime: 0,
    }
  );

  const start = useCallback(
    async (file: File, source: SearchUploadSource) => {
      setState({ step: 'uploading' });
      try {
        const blob = await uploadConsumerBlob(file);
        if (!blob.url) throw new Error(SEARCH_UPLOAD_FAILED_MESSAGE);
        const { uploadId } = await prepare.mutateAsync({ uploadUrl: blob.url, source });
        setState({ step: 'checking', uploadId, url: blob.url });
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
    /** The upload to search from once it passed: its id, and the blob URL the server does not keep. */
    ready:
      verdict === 'ready' && checking
        ? { uploadId: checking.uploadId, url: checking.url }
        : undefined,
    error:
      state.step === 'error'
        ? state.message
        : verdict === 'refused'
        ? status.data?.message ?? SEARCH_UPLOAD_FAILED_MESSAGE
        : status.error?.message,
  };
}
