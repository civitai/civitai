import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import type {
  ChallengeDetail,
  ChallengeDisplayUser,
  ChallengeJudgeInfo,
  GetInfiniteChallengesInput,
  GetCompletedChallengesWithWinnersInput,
} from '~/server/schema/challenge.schema';
import { ChallengeSort } from '~/server/schema/challenge.schema';
import { ChallengeSource } from '~/shared/utils/prisma/enums';

// The author to show on a card/detail. User challenges credit the real creator; System/Mod
// challenges present the judge persona (e.g. CivBot) — System already stores the judge as its
// creator, so this only diverges for Mod challenges, keeping the individual moderator unexposed.
// Falls back to the creator when no judge is assigned.
export function getChallengeDisplayUser(challenge: {
  source: ChallengeSource;
  createdBy: ChallengeDisplayUser;
  judge?: ChallengeJudgeInfo | null;
}): ChallengeDisplayUser {
  const { source, createdBy, judge } = challenge;
  if (source === ChallengeSource.User || !judge) return createdBy;
  return {
    id: judge.userId,
    username: judge.username,
    image: judge.image,
    profilePicture: judge.profilePicture,
    cosmetics: judge.cosmetics,
    deletedAt: judge.deletedAt,
  };
}

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

// Creators may not enter their own challenge (self-dealing on the prize pool), enforced server side
// in collection.service.ts saveItemInCollections. Intentionally stricter than that check, which
// exempts moderators: a moderator who owns a challenge still sees the blocked button, so the UI
// never invites self-dealing. Moderators keep the server-side ability if they need it.
export function useIsChallengeOwner(
  // Accepts undefined so callers can resolve ownership before their `!challenge` early return,
  // which is the only way to keep this a hook rather than a second inline copy of the rule.
  challenge?: Pick<ChallengeDetail, 'createdById' | 'source'> | null
) {
  const currentUser = useCurrentUser();

  return (
    !!currentUser &&
    !!challenge &&
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
