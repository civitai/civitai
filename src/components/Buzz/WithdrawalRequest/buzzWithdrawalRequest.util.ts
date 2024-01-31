import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  CreateBuzzWithdrawalRequestSchema,
  GetPaginatedBuzzWithdrawalRequestSchema,
} from '~/server/schema/buzz-withdrawal-request.schema';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

export const useQueryOwnedBuzzWithdrawalRequests = (
  filters?: Partial<GetPaginatedBuzzWithdrawalRequestSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.buzzWithdrawalRequest.getPaginated.useQuery(
    {
      ...filters,
    },
    {
      enabled: !!currentUser,
      ...options,
    }
  );

  if (data) {
    const { items: requests = [], ...pagination } = data;
    return { requests, pagination, ...rest };
  }

  return { requests: [], pagination: null, ...rest };
};

export const useMutateBuzzWithdrawalRequest = () => {
  const queryUtils = trpc.useContext();

  const createBuzzWithdrawalRequestMutation = trpc.buzzWithdrawalRequest.create.useMutation({
    async onSuccess() {
      await queryUtils.buzzWithdrawalRequest.getPaginated.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to create a withdrawal request',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to create a withdrawal request',
          error: new Error(error.message),
        });
      }
    },
  });

  const handleCreateBuzzWithdrawalRequest = (data: CreateBuzzWithdrawalRequestSchema) => {
    return createBuzzWithdrawalRequestMutation.mutateAsync(data);
  };

  return {
    createBuzzWithdrawalRequest: handleCreateBuzzWithdrawalRequest,
    creatingBuzzWithdrawalRequest: createBuzzWithdrawalRequestMutation.isLoading,
  };
};
