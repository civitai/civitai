import dayjs from '~/shared/utils/dayjs';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EntityAccessPermission, SignalMessages, SignalTopic } from '~/server/common/enums';
import type { ModelVersionResourceCacheItem } from '~/server/redis/caches';
import type {
  ModelVersionEarlyAccessConfig,
  ModelVersionEarlyAccessPurchase,
} from '~/server/schema/model-version.schema';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';
import { handleTRPCError, trpc } from '~/utils/trpc';

export const MIN_DONATION_GOAL = 1000;
export const MAX_DONATION_GOAL = 1000000000;

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

export const useModelVersionPermission = ({ modelVersionId }: { modelVersionId?: number }) => {
  const { data: modelVersion } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId as number },
    { enabled: !!modelVersionId }
  );
  const { data: entities, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    { entityId: [modelVersionId], entityType: 'ModelVersion' },
    { enabled: !!modelVersion }
  );
  const currentUser = useCurrentUser();

  if (!modelVersion) {
    return {
      isLoadingAccess,
      isDownloadable: true, // By default assume it is as it's our default behavior.
      isSelectableInGenerator: true, // By default assume it is as it's our default behavior.
      canDownload: false,
      canGenerate: false,
      earlyAccessEndsAt: undefined,
      earlyAccessConfig: undefined,
      modelVersion: undefined,
      isEarlyAccess: false,
    };
  }

  const [access] = entities ?? [];
  const isEarlyAccess =
    modelVersion?.earlyAccessEndsAt && modelVersion?.earlyAccessEndsAt > new Date();
  const earlyAccessConfig = modelVersion?.earlyAccessConfig as ModelVersionEarlyAccessConfig;
  const isOwnerOrMod =
    modelVersion?.model?.user?.id === currentUser?.id || currentUser?.isModerator;
  const isDownloadable =
    !modelVersion?.usageControl ||
    modelVersion?.usageControl === ModelUsageControl.Download ||
    isOwnerOrMod;
  const isSelectableInGenerator =
    modelVersion?.usageControl !== ModelUsageControl.InternalGeneration;

  return {
    isLoadingAccess,
    isDownloadable,
    isSelectableInGenerator,
    canDownload: !isEarlyAccess
      ? true
      : access?.hasAccess &&
        (access?.permissions & EntityAccessPermission.EarlyAccessDownload) !== 0,
    canGenerate:
      !isEarlyAccess || earlyAccessConfig?.freeGeneration
        ? true
        : access?.hasAccess &&
          (access?.permissions & EntityAccessPermission.EarlyAccessGeneration) != 0,
    earlyAccessEndsAt: modelVersion?.earlyAccessEndsAt,
    earlyAccessConfig: !isEarlyAccess ? undefined : earlyAccessConfig,
    modelVersion,
    isEarlyAccess,
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

export const useModelVersionTopicListener = (modelVersionId?: number) => {
  const utils = trpc.useUtils();

  useSignalTopic(modelVersionId ? `${SignalTopic.ModelVersion}:${modelVersionId}` : undefined);

  useSignalConnection(
    SignalMessages.ModelVersionPopularityUpdate,
    (data: ModelVersionResourceCacheItem) => {
      // console.log('pop update', data);
      utils.modelVersion.getPopularity.setData({ id: data.versionId }, () => {
        return {
          versionId: data.versionId,
          popularityRank: data.popularityRank ?? 0,
          isFeatured: data.isFeatured ?? false,
          isNew: data.isNew ?? false,
        };
      });
    }
  );
};
