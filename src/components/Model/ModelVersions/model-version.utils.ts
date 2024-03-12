import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export const useQueryModelVersionsEngagement = (
  { modelId, versionId }: { modelId: number; versionId: number },
  options?: { enabled?: boolean }
) => {
  const currentUser = useCurrentUser();

  const {
    data: { Notify: notifying = [], Downloaded: downloaded = [] } = { Notify: [], Downloaded: [] },
    ...rest
  } = trpc.user.getEngagedModelVersions.useQuery(
    { id: modelId },
    {
      enabled: !!currentUser && options?.enabled,
      cacheTime: Infinity,
      staleTime: Infinity,
    }
  );

  const alreadyNotifying = notifying.includes(versionId);
  const alreadyDownloaded = downloaded.includes(versionId);

  return { alreadyNotifying, alreadyDownloaded, ...rest };
};
