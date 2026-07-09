import { constants } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

export type ModelFileOptions = { precisions: string[]; quantTypes: string[] };

const fallback: ModelFileOptions = {
  precisions: [...constants.modelFileFp],
  quantTypes: [...constants.modelFileQuantTypes],
};

// Mod-managed precision + quant-type lists for model file dropdowns. The procedure is
// edge-cached 3 min (edgeCacheIt); staleTime matches so the client doesn't refetch sooner.
// Falls back to the hardcoded constants so dropdowns never render empty.
export function useModelFileOptions() {
  const { data } = trpc.modelFile.getOptions.useQuery(undefined, {
    staleTime: 3 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: fallback,
  });
  return data ?? fallback;
}
