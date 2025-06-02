import { Anchor } from '@mantine/core';
import { useRootThreadContext } from '~/components/CommentsV2/CommentsProvider';

export function ReturnToRootThread() {
  const { isInitialThread, setInitialThread, activeComment } = useRootThreadContext();

  if (isInitialThread || !activeComment) return null;

  return (
    <Anchor size="sm" onClick={setInitialThread}>
      Show full conversation
    </Anchor>
  );
}
