import { Anchor } from '@mantine/core';
import { useRootThreadContext } from '~/components/CommentsV2/CommentsProvider';
import { RETURN_TO_ROOT_THREAD_ID } from '~/components/CommentsV2/commentv2.utils';

export function ReturnToRootThread() {
  const { isInitialThread, setInitialThread, activeComment } = useRootThreadContext();

  if (isInitialThread || !activeComment) return null;

  return (
    <Anchor id={RETURN_TO_ROOT_THREAD_ID} size="sm" onClick={setInitialThread}>
      Show full conversation
    </Anchor>
  );
}
