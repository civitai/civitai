import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import type {
  ChallengeDetail,
  GetInfiniteChallengesInput,
  GetCompletedChallengesWithWinnersInput,
} from '~/server/schema/challenge.schema';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import { ChallengeSource } from '~/shared/utils/prisma/enums';

// Default filter values
const defaultFilters: Partial<GetInfiniteChallengesInput> = {
  sort: ChallengeSort.Newest,
  includeEnded: false,
  limit: 20,
};

// Hook to query challenges with infinite pagination
export function useQueryChallenges(
  filters?: Partial<GetInfiniteChallengesInput>,
  options?: { enabled?: boolean }
) {
  const { enabled = true } = options ?? {};
  const browsingLevel = useBrowsingLevelDebounced();

  const { data, ...rest } = trpc.challenge.getInfinite.useInfiniteQuery(
    { ...defaultFilters, ...filters, browsingLevel },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'challenges',
    data: flatData,
    isRefetching: rest.isRefetching,
  });

  const { isLoading, ...restWithoutLoading } = rest;

  return { challenges: items, isLoading: isLoading || loadingPreferences, ...restWithoutLoading };
}

// Hook to get a single challenge by ID
export function useQueryChallenge(id: number, options?: { enabled?: boolean }) {
  const { enabled = true } = options ?? {};

  return trpc.challenge.getById.useQuery({ id }, { enabled: enabled && id > 0 });
}

// Note: Challenge entries are stored as CollectionItems in the challenge's collection.
// Query entries via the collection ID from the challenge detail.

// Hook to get challenge winners
export function useQueryChallengeWinners(challengeId: number, options?: { enabled?: boolean }) {
  const { enabled = true } = options ?? {};

  return trpc.challenge.getWinners.useQuery(
    { challengeId },
    { enabled: enabled && challengeId > 0 }
  );
}

// Hook to query completed challenges with inline winners
export function useQueryCompletedChallengesWithWinners(
  filters?: Partial<GetCompletedChallengesWithWinnersInput>,
  options?: { enabled?: boolean }
) {
  const { enabled = true } = options ?? {};
  const browsingLevel = useBrowsingLevelDebounced();

  const { data, ...rest } = trpc.challenge.getCompletedWithWinners.useInfiniteQuery(
    { limit: 20, ...filters, browsingLevel },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  return { challenges: flatData, ...rest };
}

// Creators may not enter their own challenge (self-dealing on the prize pool). Mirrors the server
// rule in collection.service.ts saveItemInCollections, including its moderator exemption — without
// it a moderator who created a challenge sees a blocked button for a submission the server allows.
export function useIsChallengeOwner(challenge: Pick<ChallengeDetail, 'createdById' | 'source'>) {
  const currentUser = useCurrentUser();

  return (
    !!currentUser &&
    !currentUser.isModerator &&
    currentUser.id === challenge.createdById &&
    challenge.source === ChallengeSource.User
  );
}

// Hook to get winner cooldown status for the current user
export function useWinnerCooldownStatus(challengeId: number, options?: { enabled?: boolean }) {
  const { enabled = true } = options ?? {};

  return trpc.challenge.getWinnerCooldownStatus.useQuery(
    { challengeId },
    { enabled: enabled && challengeId > 0 }
  );
}

// Hook to delete a user-owned challenge (refunds escrowed Buzz)
export function useDeleteUserChallenge() {
  const utils = trpc.useUtils();

  const deleteUserChallengeMutation = trpc.challenge.deleteUserChallenge.useMutation({
    onSuccess() {
      void utils.challenge.getInfinite.invalidate();
      showSuccessNotification({
        message: 'Challenge deleted — your escrowed Buzz has been refunded.',
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to delete challenge',
        error: new Error(error.message),
      });
    },
  });

  const deleteChallenge = async (id: number) => {
    await deleteUserChallengeMutation.mutateAsync({ id });
  };

  return { deleteChallenge, deleting: deleteUserChallengeMutation.isPending };
}
