import dayjs from '~/shared/utils/dayjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { EntityAccessPermission } from '~/server/common/enums';
import type {
  ModelVersionEarlyAccessPurchase,
  ModelVersionPaidAccessDto,
} from '~/server/schema/model-version.schema';
import {
  type ModelVersionTerms,
  generationOpenToNonBuyers,
  requiresGenerationPurchase,
} from '@civitai/buzz';
import { ModelUsageControl, type ModelType } from '~/shared/utils/prisma/enums';
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
      gcTime: Infinity,
      staleTime: Infinity,
    }
  );

  const alreadyNotifying = notifying.includes(versionId);
  const alreadyDownloaded = downloaded.includes(versionId);

  return { alreadyNotifying, alreadyDownloaded, ...rest };
};

// The SSR prefetch, this query and its invalidations must share one shape: the React Query key is
// built from the raw input, before the schema coerces a scalar id into an array.
export const modelVersionAccessInput = (modelVersionId: number) => ({
  entityId: [modelVersionId],
  entityType: 'ModelVersion',
});

/**
 * The version fields `useModelVersionPermission` and its callers read. `model.getById` computes each one
 * with the same server code as `modelVersion.getById` (`paidAccess` from the same viewer-scoped
 * `getViewerMonetization`, `canGenerate` from `resolveCanGenerateForVersions`), so a page that already
 * holds the model passes this in and the hook skips its own fetch. Whether the viewer BOUGHT access is
 * not in here on either path: it comes from `common.getEntityAccess`, which purchases invalidate.
 */
export type ModelVersionPermissionData = {
  id: number;
  usageControl?: ModelUsageControl | null;
  canGenerate?: boolean;
  paidAccess?: ModelVersionPaidAccessDto | null;
  model: { id: number; type: ModelType; user: { id: number } };
};

export const toModelVersionPermissionData = (
  model: { id: number; type: ModelType; user: { id: number } },
  version: Omit<ModelVersionPermissionData, 'model'>
): ModelVersionPermissionData => ({
  id: version.id,
  usageControl: version.usageControl,
  canGenerate: version.canGenerate,
  paidAccess: version.paidAccess,
  model: { id: model.id, type: model.type, user: { id: model.user.id } },
});

/**
 * Pass `modelVersion` whenever the caller already has it (the model page does, from `model.getById`):
 * `modelVersion.getById` is then never requested. Without it — e.g. the purchase modal opened from the
 * generator — the hook fetches the version itself.
 */
export const useModelVersionPermission = ({
  modelVersionId,
  modelVersion: provided,
}: {
  modelVersionId?: number;
  modelVersion?: ModelVersionPermissionData;
}) => {
  // Page data for a different version must never answer for this one.
  const onHand = provided && provided.id === modelVersionId ? provided : undefined;
  const { data: fetched } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId as number },
    { enabled: !!modelVersionId && !onHand }
  );
  const modelVersion: ModelVersionPermissionData | undefined = onHand ?? fetched;
  const { data: entities, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    modelVersionAccessInput(modelVersionId as number),
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
      generationRequiresPurchase: false,
      paidAccess: undefined,
      modelVersion: undefined,
      isEarlyAccess: false,
    };
  }

  const [access] = entities ?? [];
  const paidAccess = modelVersion?.paidAccess;
  const paidAccessTerms = paidAccess?.terms as ModelVersionTerms | undefined;
  const hasBoughtGeneration =
    !!access?.hasAccess &&
    ((access.permissions ?? 0) & EntityAccessPermission.EarlyAccessGeneration) !== 0;
  // Active gate ⇔ permanent (endsAt null) or the timed window is still open.
  const isEarlyAccess =
    !!paidAccess && (paidAccess.endsAt == null || paidAccess.endsAt > new Date());
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
      !isEarlyAccess ||
      hasBoughtGeneration ||
      (!!paidAccessTerms && generationOpenToNonBuyers(paidAccessTerms)),
    generationRequiresPurchase:
      isEarlyAccess &&
      !!paidAccessTerms &&
      requiresGenerationPurchase(paidAccessTerms, {
        isOwnerOrMod: false,
        hasBought: hasBoughtGeneration,
      }),
    paidAccess: !isEarlyAccess ? undefined : paidAccess,
    modelVersion,
    isEarlyAccess,
  };
};

export const useMutateModelVersion = () => {
  const queryUtils = trpc.useUtils();
  const modelVersionEarlyAccessPurchaseMutation = trpc.modelVersion.earlyAccessPurchase.useMutation(
    {
      onSuccess(_, { modelVersionId }) {
        queryUtils.common.getEntityAccess.invalidate(modelVersionAccessInput(modelVersionId));

        // Manage donation goals:
        queryUtils.modelVersion.donationGoal.invalidate({ id: modelVersionId });
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
    purchasingModelVersionEarlyAccess: modelVersionEarlyAccessPurchaseMutation.isPending,
  };
};

export const useQueryModelVersionDonationGoal = (
  { modelVersionId }: { modelVersionId: number },
  options?: { enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data: donationGoal, ...other } = trpc.modelVersion.donationGoal.useQuery(
    {
      id: modelVersionId,
    },
    {
      ...(options ?? {}),
    }
  );

  return {
    donationGoal: donationGoal ?? null,
    ...other,
  };
};
