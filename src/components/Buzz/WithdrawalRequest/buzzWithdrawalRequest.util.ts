import { useUserPaymentConfiguration } from '~/components/UserPaymentConfiguration/util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GetByIdStringInput } from '~/server/schema/base.schema';
import {
  CreateBuzzWithdrawalRequestSchema,
  GetPaginatedBuzzWithdrawalRequestSchema,
  GetPaginatedOwnedBuzzWithdrawalRequestSchema,
  UpdateBuzzWithdrawalRequestSchema,
} from '~/server/schema/buzz-withdrawal-request.schema';
import { BuzzWithdrawalGetPaginatedItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const useQueryOwnedBuzzWithdrawalRequests = (
  filters?: Partial<GetPaginatedOwnedBuzzWithdrawalRequestSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { userPaymentConfiguration } = useUserPaymentConfiguration();
  const { data, ...rest } = trpc.buzzWithdrawalRequest.getPaginatedOwned.useQuery(
    {
      ...filters,
    },
    {
      enabled: !!currentUser && !!userPaymentConfiguration,
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

  const onError = (error: any, message = 'There was an error while performing your request') => {
    try {
      // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
      const parsedError = JSON.parse(error.message);
      showErrorNotification({
        title: message,
        error: parsedError,
      });
    } catch (e) {
      // Report old error as is:
      showErrorNotification({
        title: message,
        error: new Error(error.message),
      });
    }
  };

  const createBuzzWithdrawalRequestMutation = trpc.buzzWithdrawalRequest.create.useMutation({
    async onSuccess() {
      await queryUtils.buzzWithdrawalRequest.getPaginatedOwned.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to create a withdrawal request');
    },
  });

  const cancelBuzzWithdrawalRequestMutation = trpc.buzzWithdrawalRequest.cancel.useMutation({
    async onSuccess() {
      await queryUtils.buzzWithdrawalRequest.getPaginatedOwned.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to cancel a withdrawal request');
    },
  });

  const updateBuzzWithdrawalRequestMutation = trpc.buzzWithdrawalRequest.update.useMutation({
    async onSuccess() {
      await queryUtils.buzzWithdrawalRequest.getPaginated.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to update a withdrawal request');
    },
  });

  const handleCreateBuzzWithdrawalRequest = (data: CreateBuzzWithdrawalRequestSchema) => {
    return createBuzzWithdrawalRequestMutation.mutateAsync(data);
  };

  const handleCancelBuzzWithdrawalRequest = (data: GetByIdStringInput) => {
    return cancelBuzzWithdrawalRequestMutation.mutateAsync(data);
  };
  const handleUpdateBuzzWithdrawalRequest = (data: UpdateBuzzWithdrawalRequestSchema) => {
    return updateBuzzWithdrawalRequestMutation.mutateAsync(data);
  };

  return {
    createBuzzWithdrawalRequest: handleCreateBuzzWithdrawalRequest,
    creatingBuzzWithdrawalRequest: createBuzzWithdrawalRequestMutation.isLoading,
    cancelBuzzWithdrawalRequest: handleCancelBuzzWithdrawalRequest,
    cancelingBuzzWithdrawalRequest: cancelBuzzWithdrawalRequestMutation.isLoading,
    updateBuzzWithdrawalRequest: handleUpdateBuzzWithdrawalRequest,
    updatingBuzzWithdrawalRequest: updateBuzzWithdrawalRequestMutation.isLoading,
  };
};

export const useQueryBuzzWithdrawalRequests = (
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

  return { requests: [] as BuzzWithdrawalGetPaginatedItem[], pagination: null, ...rest };
};

export const useBuzzWithdrawalRequestStatus = () => {
  const { data, ...rest } = trpc.buzzWithdrawalRequest.getServiceStatus.useQuery();

  return {
    ...rest,
    data,
  };
};
