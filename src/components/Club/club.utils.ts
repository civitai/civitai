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
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useMemo } from 'react';
import {
  applyUserPreferencesClub,
  applyUserPreferencesClubPost,
} from '~/components/Search/search.utils';
import { ClubGetAll, ClubPostGetAll, ClubTier, UserClub } from '~/types/router';
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
import { ClubTransactionSchema } from '~/server/schema/buzz.schema';
import {
  AcceptClubAdminInviteInput,
  DeleteClubAdminInput,
  DeleteClubAdminInviteInput,
  GetPagedClubAdminInviteSchema,
  GetPagedClubAdminSchema,
  UpdateClubAdminInput,
  UpsertClubAdminInviteInput,
} from '~/server/schema/clubAdmin.schema';
import { isDefined, isNumber } from '../../utils/type-guards';

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

  const deleteClubTierMutation = trpc.club.deleteTier.useMutation({
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
    async onSuccess(created) {
      if (created) {
        queryUtils.clubMembership.getClubMembershipOnClub.setData(
          {
            clubId: created.club.id,
          },
          created
        );
      }
      await queryUtils.common.getEntityAccess.invalidate();
      await queryUtils.common.getEntityClubRequirement.invalidate();
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
    async onSuccess(updated) {
      if (updated) {
        queryUtils.clubMembership.getClubMembershipOnClub.setData(
          {
            clubId: updated.club.id,
          },
          (prev) => ({
            ...prev,
            ...updated,
          })
        );
      }
      await queryUtils.common.getEntityAccess.invalidate();
      await queryUtils.common.getEntityClubRequirement.invalidate();
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
    async onSuccess(updated, payload) {
      if (updated?.clubId || payload?.clubId) {
        queryUtils.clubMembership.getClubMembershipOnClub.setData(
          {
            clubId: updated?.clubId || payload?.clubId,
          },
          (prev) =>
            !updated
              ? null
              : prev
              ? {
                  ...prev,
                  ...updated,
                }
              : null
        );
      }
      await queryUtils.common.getEntityAccess.invalidate();
      await queryUtils.common.getEntityClubRequirement.invalidate();
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
    async onSuccess(updated) {
      if (updated) {
        queryUtils.clubMembership.getClubMembershipOnClub.setData(
          {
            clubId: updated.clubId,
          },
          (prev) =>
            prev
              ? {
                  ...prev,
                  ...updated,
                }
              : null
        );
      }
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

  const depositClubFundsMutation = trpc.buzz.depositClubFunds.useMutation({
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
          title: 'Failed to deposit funds from club',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to deposit funds from club',
          error: new Error(error.message),
        });
      }
    },
  });

  const togglePauseBillingMutation = trpc.clubMembership.togglePauseBilling.useMutation({
    async onSuccess() {
      await queryUtils.clubMembership.getInfinite.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to pause billing for user',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to pause billing for user',
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
  const handleDeleteClubTier = (data: GetByIdInput) => {
    return deleteClubTierMutation.mutateAsync(data);
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
  const handleWithdrawClubFunds = (data: ClubTransactionSchema) => {
    return withdrawClubFundsMutation.mutateAsync(data);
  };
  const handleDepositClubFunds = (data: ClubTransactionSchema) => {
    return depositClubFundsMutation.mutateAsync(data);
  };
  const handleTogglePauseBillingMutation = (data: OwnerRemoveClubMembershipInput) => {
    return togglePauseBillingMutation.mutateAsync(data);
  };

  return {
    upsertClub: handleUpsertClub,
    upserting: upsertClubMutation.isLoading,
    upsertClubTier: handleUpsertClubTier,
    upsertingTier: upsertClubTierMutation.isLoading,
    deleteClubTier: handleDeleteClubTier,
    deletingTier: deleteClubTierMutation.isLoading,
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
    togglePauseBilling: handleTogglePauseBillingMutation,
    togglingPauseBilling: togglePauseBillingMutation.isLoading,
    depositClubFunds: handleDepositClubFunds,
    depositingClubFunds: depositClubFundsMutation.isLoading,
  };
};

export const useEntityAccessRequirement = ({
  entityType,
  entityIds,
}: {
  entityType?: SupportedClubEntities;
  entityIds?: number[];
}) => {
  const ids = (entityIds ?? []).filter((x) => isDefined(x) && isNumber(x));
  const { data: entitiesAccess, isLoading: isLoadingAccess } = trpc.common.getEntityAccess.useQuery(
    {
      entityId: ids,
      entityType: entityType as SupportedClubEntities,
    },
    {
      enabled: ids.length > 0 && !!entityType,
    }
  );

  const { data: clubRequirements } = trpc.common.getEntityClubRequirement.useQuery(
    {
      entityId: ids,
      entityType: entityType as SupportedClubEntities,
    },
    {
      enabled: ids.length > 0 && !!entityType && !isLoadingAccess,
    }
  );

  const entities = ids.map((id) => {
    const entityAccess = entitiesAccess?.find((x) => x.entityId === id);
    const clubRequirement = clubRequirements?.find((x) => x.entityId === id);
    const hasAccess = isLoadingAccess ? false : entityAccess?.hasAccess ?? false;
    const requiresClub = clubRequirement?.requiresClub ?? false;
    return {
      entityId: id,
      entityType: entityType as SupportedClubEntities,
      hasAccess,
      requiresClub,
      clubRequirement,
    };
  });

  return {
    entities,
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
    hiddenUsers: hiddenUsers,
    hiddenImages: hiddenImages,
    hiddenTags: hiddenTags,
    hiddenLoading: isLoadingHidden,
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

export const useQueryUserContributingClubs = () => {
  const { data: userClubs = [], ...rest } = trpc.club.userContributingClubs.useQuery();

  return {
    userClubs,
    hasClubs: userClubs.length > 0,
    ...rest,
  };
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
  const showNsfw = currentUser?.showNsfw;

  const {
    hiddenImages: hiddenImages,
    hiddenTags: hiddenTags,
    hiddenUsers: hiddenUsers,
    hiddenLoading: isLoadingHidden,
  } = useHiddenPreferencesContext();

  const clubs = useMemo(() => {
    if (isLoadingHidden) return [];
    const items = data?.pages.flatMap((x) => x.items) ?? [];
    return [];
    // return applyUserPreferencesClub<ClubGetAll[number]>({
    //   items,
    //   currentUserId: currentUser?.id,
    //   hiddenImages,
    //   hiddenTags,
    //   hiddenUsers,
    //   showNsfw,
    // });
  }, [data?.pages, hiddenImages, hiddenTags, hiddenUsers, currentUser, isLoadingHidden, showNsfw]);

  return { data, clubs, ...rest };
};

export const useQueryClubAdminInvites = (
  clubId: number,
  filters?: Partial<GetPagedClubAdminInviteSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.clubAdmin.getInvitesPaged.useQuery(
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
    const { items: invites = [], ...pagination } = data;
    return { invites, pagination, ...rest };
  }

  return { invites: [], pagination: null, ...rest };
};

export const useMutateClubAdmin = () => {
  const queryUtils = trpc.useContext();

  const upsertClubAdminInvite = trpc.clubAdmin.upsertInvite.useMutation({
    async onSuccess() {
      await queryUtils.clubAdmin.getInvitesPaged.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to save invite',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to save invite',
          error: new Error(error.message),
        });
      }
    },
  });

  const deleteClubAdminInvite = trpc.clubAdmin.deleteInvite.useMutation({
    async onSuccess() {
      await queryUtils.clubAdmin.getInvitesPaged.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to delete invite',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to delete invite',
          error: new Error(error.message),
        });
      }
    },
  });

  const acceptClubAdminInvite = trpc.clubAdmin.acceptInvite.useMutation({
    async onSuccess() {
      await queryUtils.clubAdmin.getInvitesPaged.invalidate();
      await queryUtils.clubAdmin.getAdminsPaged.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to accept invite',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to accept invite',
          error: new Error(error.message),
        });
      }
    },
  });

  const updateClubAdmin = trpc.clubAdmin.update.useMutation({
    async onSuccess() {
      await queryUtils.clubAdmin.getAdminsPaged.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to update admin',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to update admin',
          error: new Error(error.message),
        });
      }
    },
  });

  const deleteClubAdmin = trpc.clubAdmin.delete.useMutation({
    async onSuccess() {
      await queryUtils.clubAdmin.getAdminsPaged.invalidate();
    },
    onError(error) {
      try {
        // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
        const parsedError = JSON.parse(error.message);
        showErrorNotification({
          title: 'Failed to delete admin',
          error: parsedError,
        });
      } catch (e) {
        // Report old error as is:
        showErrorNotification({
          title: 'Failed to delete admin',
          error: new Error(error.message),
        });
      }
    },
  });

  const handleUpsertClubAdminInvite = (data: UpsertClubAdminInviteInput) => {
    return upsertClubAdminInvite.mutateAsync(data);
  };
  const handleDeleteClubAdminInvite = (data: DeleteClubAdminInviteInput) => {
    return deleteClubAdminInvite.mutateAsync(data);
  };
  const handleAcceptClubAdminInvite = (data: AcceptClubAdminInviteInput) => {
    return acceptClubAdminInvite.mutateAsync(data);
  };
  const handleUpdateClubAdmin = (data: UpdateClubAdminInput) => {
    return updateClubAdmin.mutateAsync(data);
  };
  const handleDeleteClubAdmin = (data: DeleteClubAdminInput) => {
    return deleteClubAdmin.mutateAsync(data);
  };

  return {
    // Invites
    upsertInvite: handleUpsertClubAdminInvite,
    upsertingInvite: upsertClubAdminInvite.isLoading,
    deleteInvite: handleDeleteClubAdminInvite,
    deletingInvite: deleteClubAdminInvite.isLoading,
    acceptInvite: handleAcceptClubAdminInvite,
    acceptingInvite: acceptClubAdminInvite.isLoading,
    // Admins
    update: handleUpdateClubAdmin,
    updating: updateClubAdmin.isLoading,
    deleteAdmin: handleDeleteClubAdmin,
    deletingAdmin: deleteClubAdminInvite.isLoading,
  };
};

export const useQueryClubAdmins = (
  clubId: number,
  filters?: Partial<GetPagedClubAdminSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.clubAdmin.getAdminsPaged.useQuery(
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
    const { items: admins = [], ...pagination } = data;
    return { admins, pagination, ...rest };
  }

  return { admins: [], pagination: null, ...rest };
};
