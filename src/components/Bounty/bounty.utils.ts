import { Currency } from '@prisma/client';
import { useMemo } from 'react';

import {
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
} from '~/server/schema/bounty.schema';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { MIN_CREATE_BOUNTY_AMOUNT } from '~/server/common/constants';
import { ToggleUserBountyEngagementsInput } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import dayjs from 'dayjs';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { hideNotification, showNotification } from '@mantine/notifications';
import { TRPCClientError } from '@trpc/client';

export const getBountyCurrency = (bounty?: {
  id: number;
  user: { id: number } | null;
  benefactors: { currency: Currency; user: { id: number } }[];
}) => {
  if (!bounty || !bounty.user) {
    return Currency.BUZZ;
  }

  const mainBenefactor = bounty.benefactors.find(
    (benefactor) => benefactor.user.id === bounty.user?.id
  );

  if (mainBenefactor) {
    return mainBenefactor.currency;
  }

  // Default currency for bounties will be buzz.
  return Currency.BUZZ;
};

export const isMainBenefactor = (
  bounty?: {
    id: number;
    user: { id: number } | null;
    benefactors: { currency: Currency; user: { id: number } }[];
  },
  user?: { id: number } | null
) => {
  if (!bounty || !user) {
    return false;
  }

  return (
    !!bounty.benefactors.find((b) => b.user.id === bounty.user?.id) && bounty.user?.id === user?.id
  );
};

export const isBenefactor = (
  bounty?: {
    id: number;
    user: { id: number } | null;
    benefactors: { currency: Currency; user: { id: number } }[];
  },
  user?: { id: number } | null
) => {
  if (!bounty || !user) {
    return false;
  }

  return !!bounty.benefactors.find((b) => b.user.id === bounty.user?.id);
};

export const useBountyFilters = () => {
  const storeFilters = useFiltersContext((state) => state.bounties);
  return removeEmpty(storeFilters);
};

export const useQueryBounties = (
  filters: Partial<GetInfiniteBountySchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, ...rest } = trpc.bounty.getInfinite.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...options,
  });

  const bounties = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  return { data, bounties, ...rest };
};

export const getMainBountyAmount = (bounty?: {
  id: number;
  user: { id: number } | null;
  benefactors: { currency: Currency; user: { id: number }; unitAmount: number }[];
}) => {
  if (!bounty) {
    return 0;
  }

  const mainBenefactor = bounty.benefactors.find((b) => isMainBenefactor(bounty, b.user));

  if (mainBenefactor) {
    return mainBenefactor.unitAmount;
  }

  return MIN_CREATE_BOUNTY_AMOUNT;
};

export const useBountyEngagement = ({ bountyId }: { bountyId: number }) => {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const { data: engagements } = trpc.user.getBountyEngagement.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const toggleEngagementMutation = trpc.user.toggleBountyEngagement.useMutation({
    async onMutate({ type, bountyId }) {
      await queryUtils.user.getBountyEngagement.cancel();
      await queryUtils.bounty.getById.cancel();

      const previousEngagements = queryUtils.user.getBountyEngagement.getData() ?? {};
      const previousBounty = queryUtils.bounty.getById.getData({ id: bountyId });
      const ids = previousEngagements[type] ?? [];
      const isToggled = !!ids.find((id) => id === bountyId);

      // TODO.bounty: optimistic update current bounty stats

      queryUtils.user.getBountyEngagement.setData(undefined, (old = {}) => ({
        ...old,
        [type]: isToggled ? ids.filter((id) => id !== bountyId) : [...ids, bountyId],
      }));

      return { previousEngagements, previousBounty };
    },
    onError: (_error, _variables, context) => {
      queryUtils.user.getBountyEngagement.setData(undefined, context?.previousEngagements);
      queryUtils.bounty.getById.setData({ id: bountyId }, context?.previousBounty);
    },
  });

  const handleToggle = async ({ type }: ToggleUserBountyEngagementsInput) => {
    await toggleEngagementMutation.mutateAsync({ bountyId, type });
  };

  return { engagements, toggle: handleToggle, toggling: toggleEngagementMutation.isLoading };
};

export const getMinMaxDates = () => {
  const today = dayjs().startOf('day');

  return {
    minStartDate: today.startOf('day').toDate(),
    maxStartDate: today.clone().add(1, 'month').toDate(),
    minExpiresDate: today.clone().add(1, 'day').endOf('day').toDate(),
    maxExpiresDate: today.clone().add(1, 'day').add(1, 'month').endOf('day').toDate(),
  };
};

const DELETE_BOUNTY_TOAST_ID = 'DELETE_BOUNTY_TOAST_ID';
export const useQueryBounty = (opts?: { bountyId?: number }) => {
  const { bountyId } = opts ?? {};
  const queryUtils = trpc.useContext();
  const { data: bounty, isInitialLoading } = trpc.bounty.getById.useQuery(
    { id: bountyId as number },
    { enabled: !!bountyId }
  );

  const createBountyMutation = trpc.bounty.create.useMutation({
    async onSuccess() {
      await queryUtils.bounty.getInfinite.invalidate();
    },
    onError(error) {
      if (error instanceof TRPCClientError) {
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to create bounty',
          error: new Error(
            Array.isArray(parsedError) ? parsedError[0].message : parsedError.message
          ),
        });
      } else {
        showErrorNotification({
          title: 'Failed to create bounty',
          error: new Error(error.message),
        });
      }
    },
  });
  const updateBountyMutation = trpc.bounty.update.useMutation({
    async onSuccess(_, { id }) {
      await queryUtils.bounty.getById.invalidate({ id });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to update bounty',
        error: new Error(error.message),
      });
    },
  });
  const deleteBountyMutation = trpc.bounty.delete.useMutation({
    onMutate() {
      // Showing toast notification on mutate here because
      // we cannot show loading indicator in confirm modal
      showNotification({
        id: DELETE_BOUNTY_TOAST_ID,
        message: 'Deleting bounty...',
        loading: true,
      });
    },
    async onSuccess() {
      await queryUtils.bounty.getInfinite.invalidate();
      showSuccessNotification({ message: 'Bounty deleted' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete bounty',
        error: new Error(error.message),
      });
    },
    onSettled() {
      // Hiding notification on success or error
      hideNotification(DELETE_BOUNTY_TOAST_ID);
    },
  });

  const handleCreateBounty = (data: CreateBountyInput) => {
    return createBountyMutation.mutateAsync(data);
  };

  const handleUpdateBounty = (data: UpdateBountyInput) => {
    return updateBountyMutation.mutateAsync(data);
  };

  const handleDeleteBounty = () => {
    return deleteBountyMutation.mutateAsync({ id: bountyId as number });
  };

  return {
    bounty,
    loading: isInitialLoading,
    createBounty: handleCreateBounty,
    creating: createBountyMutation.isLoading,
    updateBounty: handleUpdateBounty,
    updating: updateBountyMutation.isLoading,
    deleteBounty: handleDeleteBounty,
    deleting: deleteBountyMutation.isLoading,
  };
};
