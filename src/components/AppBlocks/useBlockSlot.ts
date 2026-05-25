import { trpc } from '~/utils/trpc';
import type { BlockInstall, ModelSlotContext } from './types';

// Narrow to the slot ids declared in ModelSlotContext so the tRPC input's
// z.enum is satisfied without an `as` cast at the call site.
type KnownSlotId = ModelSlotContext['slotId'];

interface UseBlockSlotInput {
  slotId: KnownSlotId;
  modelId: number;
  modelType?: string;
  modelNsfwLevel?: number;
}

interface UseBlockSlotResult {
  installs: BlockInstall[];
  isLoading: boolean;
  error: Error | null;
}

/**
 * Thin wrapper over `trpc.blocks.listForModel` that gives BlockSlot a stable
 * call shape. Treats anything other than a successful array as "no installs".
 *
 * `modelType` and `modelNsfwLevel` are forwarded so the server can apply
 * platform-default `target_model_types` and content-rating filters (audit
 * I13 / I15). Both are optional — when omitted the server falls back to
 * the most restrictive defaults.
 */
export function useBlockSlot({
  slotId,
  modelId,
  modelType,
  modelNsfwLevel,
}: UseBlockSlotInput): UseBlockSlotResult {
  const query = trpc.blocks.listForModel.useQuery(
    { slotId, modelId, modelType, modelNsfwLevel },
    {
      staleTime: 60 * 1000,
      refetchOnWindowFocus: false,
    }
  );
  return {
    installs: Array.isArray(query.data) ? (query.data as BlockInstall[]) : [],
    isLoading: query.isLoading,
    error: query.error ? new Error(query.error.message) : null,
  };
}
