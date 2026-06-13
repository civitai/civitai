import { keepPreviousData } from '@tanstack/react-query';
import { trpc } from '~/utils/trpc';
import { computeSlotReservation } from './slotReservation';
import type { SlotReservation } from './slotReservation';
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
  /**
   * Server-seeded reservation derived from the current install list. Drives
   * the loading placeholder height in BlockSlotClient so the slot reserves
   * the right space up-front instead of flashing 0px → full frame.
   *
   * With the model-page SSR prefetch in place, `query.data` is already
   * populated on first client render (isLoading=false), so the reservation
   * reflects real installs immediately. On a client-side refetch we keep the
   * previous data (keepPreviousData) so the reservation — and thus the
   * reserved height — stays stable across the refetch instead of collapsing.
   */
  reservation: SlotReservation;
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
      // Keep the prior result visible across a refetch so the slot's reserved
      // height doesn't collapse to 0 (re-introducing the layout shift) while
      // the background refetch is in flight.
      placeholderData: keepPreviousData,
    }
  );
  const installs = Array.isArray(query.data) ? (query.data as BlockInstall[]) : [];
  return {
    installs,
    isLoading: query.isLoading,
    error: query.error ? new Error(query.error.message) : null,
    reservation: computeSlotReservation(installs),
  };
}
