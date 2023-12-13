import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import {
  GetInfiniteClubPostsSchema,
  GetInfiniteClubSchema,
  GetPaginatedClubResourcesSchema,
  getPaginatedClubResourcesSchema,
  RemoveClubResourceInput,
  SupportedClubEntities,
  UpdateClubResourceInput,
  UpsertClubInput,
  UpsertClubPostInput,
  UpsertClubResourceInput,
  UpsertClubTierInput,
} from '~/server/schema/club.schema';
import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { useMemo } from 'react';
import {
  applyUserPreferencesClub,
  applyUserPreferencesClubPost,
} from '~/components/Search/search.utils';
import { ClubGetAll, ClubPostGetAll, UserClub } from '~/types/router';
import {
  CreateClubMembershipInput,
  GetInfiniteClubMembershipsSchema,
  OwnerRemoveClubMembershipInput,
  ToggleClubMembershipStatusInput,
  UpdateClubMembershipInput,
} from '~/server/schema/clubMembership.schema';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { GetByIdInput } from '~/server/schema/base.schema';
import { WithdrawClubFundsSchema } from '~/server/schema/buzz.schema';

export const useQueryClub = ({ id }: { id: number }) => {
  const { data: club, isLoading: loading } = trpc.club.getById.useQuery({ id });
  return { club, loading };
};

export const useMutateClub = () => {
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

  const upsertClubPostMutation = trpc.clubPost.upsertClubPost.useMutation({
    async onSuccess(_, payload) {
      if (payload.id) {
        await queryUtils.clubPost.getById.invalidate({ id: payload.id });
      }
      await queryUtils.clubPost.getInfiniteClubPosts.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save post changes',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save post changes',
          error: new Error(error.message),
        });
      }
    },
  });

  const createClubMembershipMutation = trpc.clubMembership.createClubMembership.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getClubMembershipOnClub.invalidate();
      await queryUtils.club.userContributingClubs.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to join club',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to join club',
          error: new Error(error.message),
        });
      }
    },
  });

  const updateClubMembershipMutation = trpc.clubMembership.updateClubMembership.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getClubMembershipOnClub.invalidate();
      await queryUtils.club.userContributingClubs.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to update membership',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to update membership',
          error: new Error(error.message),
        });
      }
    },
  });

  const removeAndRefundMemberMutation = trpc.clubMembership.removeAndRefundMember.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to remove and refund user',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to remove and refund user',
          error: new Error(error.message),
        });
      }
    },
  });

  const updateClubResourceMutation = trpc.club.updateResource.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to update resource',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to update resource',
          error: new Error(error.message),
        });
      }
    },
  });

  const removeClubResourceMutation = trpc.club.removeResource.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to remove resource',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to remove resource',
          error: new Error(error.message),
        });
      }
    },
  });

  const cancelClubMembershipMutation = trpc.clubMembership.cancelClubMembership.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getClubMembershipOnClub.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to cancel membership',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to cancel membership',
          error: new Error(error.message),
        });
      }
    },
  });

  const restoreClubMembershipMutation = trpc.clubMembership.restoreClubMembership.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getClubMembershipOnClub.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to restore membership',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to restore membership',
          error: new Error(error.message),
        });
      }
    },
  });

  const deleteClubMutation = trpc.club.delete.useMutation({
    async onSuccess() {
      await queryUtils.club.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to delete club',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to delete club',
          error: new Error(error.message),
        });
      }
    },
  });

  const deleteClubPostMutation = trpc.clubPost.delete.useMutation({
    async onSuccess() {
      await queryUtils.club.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to delete club post',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to delete club post',
          error: new Error(error.message),
        });
      }
    },
  });

  const withdrawClubFundsMutation = trpc.buzz.withdrawClubFunds.useMutation({
    async onSuccess(_, { clubId }) {
      await queryUtils.buzz.getBuzzAccount.invalidate({
        accountId: clubId,
        accountType: 'Club',
      });
      await queryUtils.buzz.getAccountTransactions.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to withdraw funds from club',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to withdraw funds from club',
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
  const handleUpsertClubPost = (data: UpsertClubPostInput) => {
    return upsertClubPostMutation.mutateAsync(data);
  };
  const handleCreateClubMembership = (data: CreateClubMembershipInput) => {
    return createClubMembershipMutation.mutateAsync(data);
  };
  const handleUpdateClubMembership = (data: UpdateClubMembershipInput) => {
    return updateClubMembershipMutation.mutateAsync(data);
  };
  const handleRemoveAndRefundMember = (data: OwnerRemoveClubMembershipInput) => {
    return removeAndRefundMemberMutation.mutateAsync(data);
  };
  const handleCancelClubMembership = (data: ToggleClubMembershipStatusInput) => {
    return cancelClubMembershipMutation.mutateAsync(data);
  };
  const handleRestoreClubMembership = (data: ToggleClubMembershipStatusInput) => {
    return restoreClubMembershipMutation.mutateAsync(data);
  };
  const handleUpdateClubResource = (data: UpdateClubResourceInput) => {
    return updateClubResourceMutation.mutateAsync(data);
  };
  const handleRemoveClubResource = (data: RemoveClubResourceInput) => {
    return removeClubResourceMutation.mutateAsync(data);
  };
  const handleDeleteClub = (data: GetByIdInput) => {
    return deleteClubMutation.mutateAsync(data);
  };
  const handleDeleteClubPost = (data: GetByIdInput) => {
    return deleteClubPostMutation.mutateAsync(data);
  };
  const handleWithdrawClubFunds = (data: WithdrawClubFundsSchema) => {
    return withdrawClubFundsMutation.mutateAsync(data);
  };

  return {
    upsertClub: handleUpsertClub,
    upserting: upsertClubMutation.isLoading,
    upsertClubTier: handleUpsertClubTier,
    upsertingTier: upsertClubTierMutation.isLoading,
    upsertClubResource: handleUpsertClubResource,
    upsertingResource: upsertClubResourceMutation.isLoading,
    upsertClubPost: handleUpsertClubPost,
    upsertingClubPost: upsertClubPostMutation.isLoading,
    createClubMembership: handleCreateClubMembership,
    creatingClubMembership: createClubMembershipMutation.isLoading,
    updateClubMembership: handleUpdateClubMembership,
    updatingClubMembership: updateClubMembershipMutation.isLoading,
    removeAndRefundMember: handleRemoveAndRefundMember,
    removingAndRefundingMember: removeAndRefundMemberMutation.isLoading,
    updateResource: handleUpdateClubResource,
    updatingResource: updateClubResourceMutation.isLoading,
    removeResource: handleRemoveClubResource,
    removingResource: removeClubResourceMutation.isLoading,
    cancelClubMembership: handleCancelClubMembership,
    cancelingClubMembership: cancelClubMembershipMutation.isLoading,
    restoreClubMembership: handleRestoreClubMembership,
    restoringClubMembership: restoreClubMembershipMutation.isLoading,
    deleteClub: handleDeleteClub,
    deletingClub: deleteClubMutation.isLoading,
    deleteClubPost: handleDeleteClubPost,
    deletingClubPost: deleteClubPostMutation.isLoading,
    withdrawClubFunds: handleWithdrawClubFunds,
    withdrawingClubFunds: withdrawClubFundsMutation.isLoading,
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
    clubRequirement,
    hasAccess,
    requiresClub,
    isLoadingAccess,
  };
};

export const useQueryClubPosts = (
  clubId: number,
  filters?: Partial<GetInfiniteClubPostsSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, ...rest } = trpc.clubPost.getInfiniteClubPosts.useInfiniteQuery(
    {
      clubId,
      ...filters,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      ...options,
    }
  );
  const currentUser = useCurrentUser();
  const {
    users: hiddenUsers,
    images: hiddenImages,
    tags: hiddenTags,
    isLoading: isLoadingHidden,
  } = useHiddenPreferencesContext();

  const clubPosts = useMemo(() => {
    if (isLoadingHidden) return [];
    const items = data?.pages.flatMap((x) => x.items) ?? [];
    return applyUserPreferencesClubPost<ClubPostGetAll[number]>({
      items,
      currentUserId: currentUser?.id,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
    });
  }, [data?.pages, hiddenImages, hiddenTags, hiddenUsers, currentUser, isLoadingHidden]);

  return { data, clubPosts, ...rest };
};

export const useClubContributorStatus = ({ clubId }: { clubId?: number }) => {
  const { data: userClubs = [], ...rest } = trpc.club.userContributingClubs.useQuery(undefined, {
    enabled: !!clubId,
  });
  const currentUser = useCurrentUser();

  const userClub = useMemo(() => {
    if (!userClubs || !currentUser) return null;

    const userClub = userClubs.find((x) => x.id === clubId);

    return userClub ?? null;
  }, [userClubs, currentUser, clubId]);

  return {
    isClubAdmin: !!userClub?.admin,
    isOwner: currentUser && userClub?.userId === currentUser?.id,
    isModerator: currentUser?.isModerator,
    permissions: userClub?.admin?.permissions ?? [],
    ...rest,
  };
};

export const useQueryClubMembership = (
  clubId: number,
  filters?: Partial<GetInfiniteClubMembershipsSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.clubMembership.getInfinite.useInfiniteQuery(
    {
      ...filters,
      clubId,
    },
    {
      enabled: !!currentUser,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      ...options,
    }
  );

  const memberships = useMemo(() => {
    return data?.pages.flatMap((x) => x.items) ?? [];
  }, [data?.pages]);

  return { memberships, ...rest };
};

export const useQueryClubResources = (
  clubId: number,
  filters?: Partial<GetPaginatedClubResourcesSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.club.getPaginatedClubResources.useQuery(
    {
      ...filters,
      clubId,
    },
    {
      enabled: !!currentUser,
      ...options,
    }
  );

  if (data) {
    const { items: resources = [], ...pagination } = data;
    return { resources, pagination, ...rest };
  }

  return { resources: [], pagination: null, ...rest };
};

export const useClubFilters = () => {
  const storeFilters = useFiltersContext((state) => state.clubs);
  return removeEmpty(storeFilters);
};

export const useQueryClubs = (
  filters: Partial<GetInfiniteClubSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, ...rest } = trpc.club.getInfinite.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...options,
  });
  const currentUser = useCurrentUser();
  const browsingMode = useFiltersContext((state) => state.browsingMode);

  const {
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: isLoadingHidden,
  } = useHiddenPreferencesContext();

  const clubs = useMemo(() => {
    if (isLoadingHidden) return [];
    const items = data?.pages.flatMap((x) => x.items) ?? [];
    return applyUserPreferencesClub<ClubGetAll[number]>({
      items,
      currentUserId: currentUser?.id,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
      browsingMode,
    });
  }, [
    data?.pages,
    hiddenImages,
    hiddenTags,
    hiddenUsers,
    currentUser,
    isLoadingHidden,
    browsingMode,
  ]);

  return { data, clubs, ...rest };
};
