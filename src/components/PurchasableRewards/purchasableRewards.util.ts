import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  PurchasableRewardUpsert,
  GetPaginatedPurchasableRewardsSchema,
  GetPaginatedPurchasableRewardsModeratorSchema,
  PurchasableRewardPurchase,
} from '~/server/schema/purchasable-reward.schema';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { PurchasableRewardGetPaged } from '~/types/router';

export const useMutatePurchasableReward = () => {
  const queryUtils = trpc.useUtils();

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

  const upsertPurchasableReward = trpc.purchasableReward.upsert.useMutation({
    async onSuccess() {
      await queryUtils.purchasableReward.getPaged.invalidate();
      await queryUtils.purchasableReward.getModeratorPaged.invalidate();
    },
    onError(error) {
      onError(error, 'Failed to create a reward');
    },
  });

  const purchasePurchasableReward = trpc.purchasableReward.purchase.useMutation({
    async onSuccess(result) {
      await queryUtils.purchasableReward.getPaged.invalidate();

      queryUtils.user.getUserPurchasedRewards.setData(undefined, (old) => {
        if (!old) return [result];
        return [...old, result];
      });
    },
    onError(error) {
      onError(error, 'Failed to purchase reward');
    },
  });

  const handleUpsertPurchasableReward = (data: PurchasableRewardUpsert) => {
    return upsertPurchasableReward.mutateAsync(data);
  };

  const handlePurchasePurchasableReward = (data: PurchasableRewardPurchase) => {
    return purchasePurchasableReward.mutateAsync(data);
  };

  return {
    upsertPurchasableReward: handleUpsertPurchasableReward,
    upsertingPurchasableReward: upsertPurchasableReward.isLoading,
    purchasePurchasableReward: handlePurchasePurchasableReward,
    purchasingPurchasableReward: purchasePurchasableReward.isLoading,
  };
};

export const useQueryPurchasableRewards = (
  filters?: Partial<GetPaginatedPurchasableRewardsSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.purchasableReward.getPaged.useQuery(
    {
      ...filters,
    },
    {
      enabled: !!currentUser,
      ...options,
    }
  );

  if (data) {
    const { items: purchasableRewards = [], ...pagination } = data;
    return { purchasableRewards, pagination, ...rest };
  }

  return { purchasableRewards: [], pagination: null, ...rest };
};

export const useQueryPurchasableRewardsModerator = (
  filters?: Partial<GetPaginatedPurchasableRewardsModeratorSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.purchasableReward.getModeratorPaged.useQuery(
    {
      ...filters,
    },
    {
      enabled: !!currentUser,
      ...options,
    }
  );

  if (data) {
    const { items: purchasableRewards = [], ...pagination } = data;
    return { purchasableRewards, pagination, ...rest };
  }

  return { purchasableRewards: [], pagination: null, ...rest };
};

export const useUserPurchasedRewards = () => {
  const currentUser = useCurrentUser();
  const { data = [], ...rest } = trpc.user.getUserPurchasedRewards.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    purchasedRewards: data,
    ...rest,
  };
};

export const isPurchasableRewardActive = (purchasableReward: PurchasableRewardGetPaged) => {
  if (purchasableReward.archived) {
    return false;
  }

  const now = new Date();
  if (purchasableReward.availableFrom && purchasableReward.availableFrom > now) {
    return false;
  }

  if (purchasableReward.availableTo && purchasableReward.availableTo < now) {
    return false;
  }

  if (
    purchasableReward.availableCount !== null &&
    purchasableReward.availableCount - purchasableReward._count.purchases <= 0
  ) {
    return false;
  }

  return true;
};
