import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import {
  SupportedClubEntities,
  UpsertClubInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';

export const useQueryClub = ({ id }: { id: number }) => {
  const { data: club, isLoading: loading } = trpc.club.getById.useQuery({ id });
  return { club, loading };
};

export const useMutateClub = (opts?: { clubId?: number }) => {
  const { clubId } = opts ?? {};
  const queryUtils = trpc.useContext();

  const upsertClubMutation = trpc.club.upsert.useMutation({
    async onSuccess(result, payload) {
      if (payload.id) await queryUtils.club.getById.invalidate({ id: payload.id });
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save club',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save club',
          error: new Error(error.message),
        });
      }
    },
  });

  const upsertClubTierMutation = trpc.club.upsertTier.useMutation({
    async onSuccess() {
      await queryUtils.club.getTiers.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save club tier',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save club tier',
          error: new Error(error.message),
        });
      }
    },
  });

  const upsertClubResourceMutation = trpc.club.upsertResource.useMutation({
    async onSuccess() {
      await queryUtils.club.resourceDetails.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save resource changes',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save resource changes',
          error: new Error(error.message),
        });
      }
    },
  });
  const handleUpsertClub = (data: UpsertClubInput) => {
    return upsertClubMutation.mutateAsync(data);
  };

  const handleUpsertClubTier = (data: UpsertClubTierInput) => {
    return upsertClubTierMutation.mutateAsync(data);
  };
  const handleUpsertClubResource = (data: UpsertClubResourceInput) => {
    return upsertClubResourceMutation.mutateAsync(data);
  };

  return {
    upsertClub: handleUpsertClub,
    upserting: upsertClubMutation.isLoading,
    upsertClubTier: handleUpsertClubTier,
    upsertingTier: upsertClubTierMutation.isLoading,
    upsertClubResource: handleUpsertClubResource,
    upsertingResource: upsertClubResourceMutation.isLoading,
  };
};

export const useEntityAccessRequirement = ({
  entityType,
  entityId,
}: {
  entityType?: SupportedClubEntities;
  entityId?: number;
}) => {
  const { data: entityAccess, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    {
      entityId: entityId as number,
      entityType: entityType as SupportedClubEntities,
    },
    {
      enabled: !!entityId && !!entityType,
    }
  );

  const hasAccess = isLoadingAccess ? false : entityAccess?.hasAccess ?? false;

  const { data: clubRequirement } = trpc.common.getEntityClubRequirement.useQuery(
    {
      entityId: entityId as number,
      entityType: entityType as SupportedClubEntities,
    },
    {
      enabled: !!entityId && !!entityType && !hasAccess && !isLoadingAccess,
    }
  );

  const requiresClub = clubRequirement?.requiresClub ?? false;

  return {
    hasAccess,
    requiresClub,
    isLoadingAccess,
  };
};
