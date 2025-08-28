import { trpc } from '~/utils/trpc';
import { CacheTTL } from '~/server/common/constants';

interface UseModerationBlocklistsOptions {
  enabled?: boolean;
}

export function useModerationBlocklists(options: UseModerationBlocklistsOptions = {}) {
  const { enabled = true } = options;

  return trpc.system.getModerationBlocklists.useQuery(undefined, {
    staleTime: 1000 * CacheTTL.day,
    cacheTime: 1000 * CacheTTL.day,
    enabled,
  });
}
