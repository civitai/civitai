import { Alert, Skeleton } from '@mantine/core';

type FallbackReason = 'loading' | 'token_error' | 'timeout' | 'fatal_block_error';

interface BlockFallbackProps {
  reason: FallbackReason;
  blockName?: string;
  minHeight?: number;
}

const DEFAULT_MIN_HEIGHT = 200;

export function BlockFallback({
  reason,
  blockName,
  minHeight = DEFAULT_MIN_HEIGHT,
}: BlockFallbackProps) {
  if (reason === 'loading') {
    return <Skeleton h={minHeight} radius="md" data-block-fallback="loading" />;
  }
  if (reason === 'token_error') {
    return (
      <Alert color="yellow" data-block-fallback="token_error">
        Block unavailable — authorization error
      </Alert>
    );
  }
  if (reason === 'timeout') {
    return (
      <Alert color="gray" data-block-fallback="timeout">
        Block took too long to load
      </Alert>
    );
  }
  return (
    <Alert color="red" data-block-fallback="fatal_block_error">
      Block {blockName ?? ''} reported an error
    </Alert>
  );
}
