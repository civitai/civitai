import { hideNotification, showNotification } from '@mantine/notifications';
import dayjs from '~/shared/utils/dayjs';
import { useMemo } from 'react';
import produce from 'immer';
import * as z from 'zod';

import { Currency, BountyEngagementType, BountyType } from '~/shared/utils/prisma/enums';
import type {
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
  UpsertBountyInput,
} from '~/server/schema/bounty.schema';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { constants } from '~/server/common/constants';
import type { ToggleUserBountyEngagementsInput } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { BountySort, BountyStatus } from '~/server/common/enums';

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

export type BountyEngagementTypeQueryParam = (typeof constants.bounties.engagementTypes)[number];

const bountyQueryParamsSchema = z.object({
  types: z.enum(BountyType).array().optional(),
  status: z.enum(BountyStatus).optional(),
  sort: z.enum(BountySort).optional(),
  engagement: z.enum(constants.bounties.engagementTypes).optional(),
});

export const useBountyFilters = () => {
  const storeFilters = useFiltersContext((state) => state.bounties);
  const { query } = useBountyQueryParams();

  return removeEmpty({ ...storeFilters, ...query });
};

export const useBountyQueryParams = () => useZodRouteParams(bountyQueryParamsSchema);

export const useQueryBounties = (
  filters: Partial<GetInfiniteBountySchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, isLoading, ...rest } = trpc.bounty.getInfinite.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      ...options,
      trpc: { context: { skipBatch: true } },
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items: bounties, loadingPreferences } = useApplyHiddenPreferences({
    type: 'bounties',
    data: flatData,
    isRefetching: rest.isRefetching,
  });

  return { data, bounties, isLoading: isLoading || loadingPreferences, ...rest };
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

  return constants.bounties.minCreateAmount;
};

export const useQueryBountyEngagements = () => {
  const currentUser = useCurrentUser();

  const { data: engagements, isInitialLoading: loading } = trpc.user.getBountyEngagement.useQuery(
    undefined,
    { enabled: !!currentUser, cacheTime: Infinity, staleTime: Infinity }
  );

  return { engagements, loading };
};

export const useBountyEngagement = () => {
  const queryUtils = trpc.useUtils();
  const { engagements } = useQueryBountyEngagements();

  const toggleEngagementMutation = trpc.user.toggleBountyEngagement.useMutation({
    async onMutate({ type, bountyId }) {
      await queryUtils.user.getBountyEngagement.cancel();
      await queryUtils.bounty.getById.cancel();

      const previousEngagements = queryUtils.user.getBountyEngagement.getData() ?? {};
      const previousBounty = queryUtils.bounty.getById.getData({ id: bountyId });
      const ids = previousEngagements[type] ?? [];
      const isToggled = !!ids.find((id) => id === bountyId);

      if (type === BountyEngagementType.Favorite) {
        queryUtils.bounty.getById.setData(
          { id: bountyId },
          produce((bounty) => {
            if (!bounty?.stats) return;
            const favoriteCount = bounty.stats.favoriteCountAllTime;
            bounty.stats.favoriteCountAllTime += !isToggled ? 1 : favoriteCount > 0 ? -1 : 0;
          })
        );
      }

      if (type === BountyEngagementType.Track) {
        queryUtils.bounty.getById.setData(
          { id: bountyId },
          produce((bounty) => {
            if (!bounty?.stats) return;
            const trackCount = bounty.stats.trackCountAllTime;
            bounty.stats.trackCountAllTime += !isToggled ? 1 : trackCount > 0 ? -1 : 0;
          })
        );
      }

      queryUtils.user.getBountyEngagement.setData(undefined, (old = {}) => ({
        ...old,
        [type]: isToggled ? ids.filter((id) => id !== bountyId) : [...ids, bountyId],
      }));

      return { previousEngagements, previousBounty };
    },
    onError: (_error, { bountyId }, context) => {
      queryUtils.user.getBountyEngagement.setData(undefined, context?.previousEngagements);
      queryUtils.bounty.getById.setData({ id: bountyId }, context?.previousBounty);
    },
  });

  const handleToggle = async (payload: ToggleUserBountyEngagementsInput) => {
    await toggleEngagementMutation.mutateAsync(payload);
  };

  return { engagements, toggle: handleToggle, toggling: toggleEngagementMutation.isLoading };
};

export const getMinMaxDates = () => {
  const today = dayjs().startOf('day');

  return {
    minStartDate: today.toDate(),
    maxStartDate: today.clone().add(1, 'month').toDate(),
    minExpiresDate: today.clone().add(1, 'day').endOf('day').toDate(),
    maxExpiresDate: today.clone().add(1, 'day').add(1, 'month').endOf('day').toDate(),
  };
};

export const useQueryBounty = ({ id }: { id: number }) => {
  const { data: bounty, isLoading: loading } = trpc.bounty.getById.useQuery({ id });

  return { bounty, loading };
};

const DELETE_BOUNTY_TOAST_ID = 'DELETE_BOUNTY_TOAST_ID';
export const useMutateBounty = (opts?: { bountyId?: number }) => {
  const { bountyId } = opts ?? {};
  const queryUtils = trpc.useUtils();

  const { toggle } = useBountyEngagement();

  const createBountyMutation = trpc.bounty.create.useMutation({
    async onSuccess({ id }) {
      await toggle({ type: BountyEngagementType.Track, bountyId: id });
      await queryUtils.bounty.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to create bounty',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
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

  const upsertBountyMutation = trpc.bounty.upsert.useMutation({
    async onSuccess(result, payload) {
      if (payload.id) await queryUtils.bounty.getById.invalidate({ id: payload.id });
      else await toggle({ type: BountyEngagementType.Track, bountyId: result.id });
      await queryUtils.bounty.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save bounty',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save bounty',
          error: new Error(error.message),
        });
      }
    },
  });

  const refundBountyMutation = trpc.bounty.refund.useMutation({
    async onSuccess() {
      await queryUtils.bounty.getById.invalidate({ id: bountyId });
      showSuccessNotification({ message: 'Bounty refunded' });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to refund bounty',
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
    if (!bountyId) return;
    return updateBountyMutation.mutateAsync({ ...data, id: bountyId });
  };

  const handleDeleteBounty = () => {
    if (!bountyId) return;
    return deleteBountyMutation.mutateAsync({ id: bountyId });
  };

  const handleRefundBounty = () => {
    if (!bountyId) return;
    return refundBountyMutation.mutateAsync({ id: bountyId });
  };

  const handleUpsertBounty = (data: UpsertBountyInput) => {
    return upsertBountyMutation.mutateAsync(data);
  };

  return {
    createBounty: handleCreateBounty,
    creating: createBountyMutation.isLoading,
    updateBounty: handleUpdateBounty,
    updating: updateBountyMutation.isLoading,
    deleteBounty: handleDeleteBounty,
    deleting: deleteBountyMutation.isLoading,
    refundBounty: handleRefundBounty,
    refunding: refundBountyMutation.isLoading,
    upsertBounty: handleUpsertBounty,
    upserting: upsertBountyMutation.isLoading,
  };
};
