import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { UpsertBountyInput } from '~/server/schema/bounty.schema';
import { UpsertClubInput } from '~/server/schema/club.schema';

export const useQueryClub = ({ id }: { id: number }) => {
  const { data: club, isLoading: loading } = trpc.club.getById.useQuery({ id });

  return { club, loading };
};

export const useMutateClub = (opts?: { clubId?: number }) => {
  const { clubId } = opts ?? {};

  const upsertClubMutation = trpc.club.upsert.useMutation({
    async onSuccess(result, payload) {
      // if (payload.id) await queryUtils.bounty.getById.invalidate({ id: payload.id });
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

  const handleUpsertClub = (data: UpsertClubInput) => {
    return upsertClubMutation.mutateAsync(data);
  };

  return {
    upsertClub: handleUpsertClub,
    upserting: upsertClubMutation.isLoading,
  };
};
