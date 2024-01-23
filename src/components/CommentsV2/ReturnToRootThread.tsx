import { Anchor } from '@mantine/core';
import { useRootThreadContext } from '~/components/CommentsV2';

export function ReturnToRootThread() {
  const { isInitialThread, setInitialThread, activeComment } = useRootThreadContext();

  if (isInitialThread || !activeComment) return null;

  return (
    <Anchor size="sm" component="a" onClick={setInitialThread}>
      Show full conversation
    </Anchor>
  );
}
