import { trpc } from '~/utils/trpc';

export function useGetGenerationEngines() {
  return trpc.generation.getGenerationEngines.useQuery();
}
