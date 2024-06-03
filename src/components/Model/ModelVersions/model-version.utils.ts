import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EntityAccessPermission } from '~/server/common/enums';
import {
  ModelVersionEarlyAccessConfig,
  ModelVersionEarlyAccessPurchase,
} from '~/server/schema/model-version.schema';
import { handleTRPCError, trpc } from '~/utils/trpc';

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

export const useModelVersionPermission = ({ modelVersionId }: { modelVersionId: number }) => {
  const { data: modelVersion } = trpc.modelVersion.getById.useQuery({ id: modelVersionId });

  const { data: entities, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    {
      entityId: [modelVersionId],
      entityType: 'ModelVersion',
    },
    {
      enabled: !!modelVersion,
    }
  );

  const [access] = entities ?? [];
  const isEarlyAccess =
    modelVersion?.earlyAccessEndsAt && modelVersion?.earlyAccessEndsAt > new Date();
  const earlyAccessConfig = modelVersion?.earlyAccessConfig as ModelVersionEarlyAccessConfig;

  return {
    isLoadingAccess,
    canDownload: !isEarlyAccess
      ? true
      : access?.hasAccess &&
        (access?.permissions & EntityAccessPermission.EarlyAccessDownload) !== 0,
    canGenerate: !isEarlyAccess
      ? true
      : access?.hasAccess &&
        (access?.permissions & EntityAccessPermission.EarlyAccessGeneration) != 0,
    earlyAccessEndsAt: modelVersion?.earlyAccessEndsAt,
    earlyAccessConfig: !isEarlyAccess ? undefined : earlyAccessConfig,
    modelVersion,
  };
};

export const useMutateModelVersion = () => {
  const queryUtils = trpc.useUtils();
  const modelVersionEarlyAccessPurchaseMutation = trpc.modelVersion.earlyAccessPurchase.useMutation(
    {
      onSuccess(_, { modelVersionId }) {
        queryUtils.common.getEntityAccess.invalidate({
          entityId: [modelVersionId],
          entityType: 'ModelVersion',
        });

        // Manage donation goals:
        queryUtils.modelVersion.donationGoals.invalidate({ id: modelVersionId });
      },
      onError(error) {
        handleTRPCError(error, 'Failed to purchase early access');
      },
    }
  );

  const handleModelVersionEarlyAccessPurchase = (input: ModelVersionEarlyAccessPurchase) => {
    return modelVersionEarlyAccessPurchaseMutation.mutateAsync(input);
  };

  return {
    modelVersionEarlyAccessPurchase: handleModelVersionEarlyAccessPurchase,
    purchasingModelVersionEarlyAccess: modelVersionEarlyAccessPurchaseMutation.isLoading,
  };
};

export const useQueryModelVersionDonationGoals = (
  { modelVersionId }: { modelVersionId: number },
  options?: { enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data: donationGoals, ...other } = trpc.modelVersion.donationGoals.useQuery(
    {
      id: modelVersionId,
    },
    {
      ...(options ?? {}),
    }
  );

  return {
    donationGoals: donationGoals ?? [],
    ...other,
  };
};
