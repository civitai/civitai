import dynamic from 'next/dynamic';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelSlotContext } from './types';
import { slotRemountKey } from './types';

interface BlockSlotProps {
  slotId: ModelSlotContext['slotId'];
  context: ModelSlotContext;
}

// Lazy + client-only. The server returns null and lets the client decide
// whether to mount — this avoids the empty wrapper-div eating a 16px gap row
// inside the sidebar Stack in v1 (zero installs in prod).
const BlockSlotClient = dynamic(
  () => import('./BlockSlotClient').then((m) => m.BlockSlotClient),
  {
    ssr: false,
    loading: () => null,
  }
);

/**
 * Renders all enabled block installs for a (slotId, modelId) pair. Capped at
 * 3 installs per slot by the server (see BlockRegistry.listForModel).
 *
 * Gated by the `appBlocks` feature flag — when off (default for v1), this
 * renders nothing and no token-issuance traffic fires. The flag is the
 * launch lever for the app-blocks substrate as a whole; the per-block
 * emergency kill list (system:blocks:emergency-kill-list) is the
 * fine-grained tool for ops to disable a specific runaway block.
 *
 * Public — anon viewers see the same blocks as authenticated viewers.
 */
export function BlockSlot({ slotId, context }: BlockSlotProps) {
  const features = useFeatureFlags();
  if (!features.appBlocks) return null;
  // The wrapper div is rendered by BlockSlotClient only when there are
  // installs to show; otherwise BlockSlot returns null entirely (no empty
  // gap row in the sidebar Stack).
  //
  // H-4: key on (slotId, entityType, entityId) so navigation between model
  // pages force-unmounts the client. Previously the same mount would persist
  // across model changes; the iframe could receive a single frame of
  // BLOCK_INIT with the new slotContext for the old install before the
  // tRPC query refreshed and BlockHost-keyed remount caught up. The
  // entity-agnostic helper PRESERVES the model behavior exactly: for a model
  // context the entity id is the modelId, so this remains
  // `${slotId}:model:${modelId}` and force-unmounts on model navigation.
  return (
    <BlockSlotClient
      key={slotRemountKey({ slotId, entityType: 'model', entityId: context.modelId })}
      slotId={slotId}
      context={context}
    />
  );
}
