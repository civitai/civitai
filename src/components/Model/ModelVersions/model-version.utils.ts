import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EntityAccessPermission } from '~/server/common/enums';
import { ModelVersionEarlyAccessConfig } from '~/server/schema/model-version.schema';
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

export const useModelVersionPermission = ({ modelVersionId  } : { modelVersionId: number }) => { 
   const { data: modelVersion } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId },
  );


  const { data: entities, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    {
      entityId: [modelVersionId],
      entityType: 'ModelVersion',
    }, {
      enabled: !!modelVersion,
    }
  );



  const [access] = entities ?? [];
  const isEarlyAccess = modelVersion?.earlyAccessEndsAt && modelVersion?.earlyAccessEndsAt > new Date();
  const earlyAccessConfig = modelVersion?.earlyAccessConfig as ModelVersionEarlyAccessConfig;


  return {
    isLoadingAccess,
    canDownload: !isEarlyAccess ? true : access?.hasAccess && access?.permissions >= EntityAccessPermission.EarlyAccessDownload,
    canGenerate: !isEarlyAccess ? true : access?.hasAccess && access?.permissions >= EntityAccessPermission.EarlyAccessGeneration,
    earlyAccessConfig: !isEarlyAccess ? undefined : earlyAccessConfig,
  };
}