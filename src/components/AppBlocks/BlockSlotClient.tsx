import { Stack } from '@mantine/core';
import { BlockErrorBoundary } from './BlockErrorBoundary';
import { BlockHost } from './BlockHost';
import { useBlockSlot } from './useBlockSlot';
import type { ModelSlotContext } from './types';

interface BlockSlotClientProps {
  slotId: ModelSlotContext['slotId'];
  context: ModelSlotContext;
}

/**
 * Client-only renderer used by BlockSlot. Querying the registry requires a
 * tRPC client, so this lives behind a `dynamic(..., { ssr: false })` in
 * BlockSlot.tsx to keep the server bundle clean.
 */
export function BlockSlotClient({ slotId, context }: BlockSlotClientProps) {
  const { installs, isLoading, error } = useBlockSlot({
    slotId,
    modelId: context.modelId,
    modelType: context.modelType,
    modelNsfwLevel: context.modelNsfwLevel,
  });

  if (error) return null; // fail-soft — never surface a block error as page-level
  if (isLoading) return null;
  if (installs.length === 0) return null;

  return (
    <div data-block-slot={slotId} data-block-count={installs.length}>
      <Stack gap="md">
        {installs.map((install) => (
          <BlockErrorBoundary key={install.blockInstanceId} blockName={install.manifest.name}>
            <BlockHost blockInstall={install} slotContext={context} />
          </BlockErrorBoundary>
        ))}
      </Stack>
    </div>
  );
}
