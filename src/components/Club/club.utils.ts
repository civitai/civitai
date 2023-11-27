import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import {
  UpsertClubEntityInput,
  UpsertClubInput,
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
  const upsertClubEntityMutation = trpc.club.upsertClubEntity.useMutation({
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save club entity',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save club entity',
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

  const handleUpsertClubEntity = (data: UpsertClubEntityInput) => {
    return upsertClubEntityMutation.mutateAsync(data);
  };

  return {
    upsertClub: handleUpsertClub,
    upserting: upsertClubMutation.isLoading,
    upsertClubTier: handleUpsertClubTier,
    upsertingTier: upsertClubTierMutation.isLoading,
    upsertClubEntity: handleUpsertClubEntity,
    upsertingClubEntity: upsertClubEntityMutation.isLoading,
  };
};
