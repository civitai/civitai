import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { trpc } from '~/utils/trpc';
import type {
  GetInfiniteChallengesInput,
  GetCompletedChallengesWithWinnersInput,
} from '~/server/schema/challenge.schema';
import { ChallengeSort } from '~/server/schema/challenge.schema';

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

// Hook to get winner cooldown status for the current user
export function useWinnerCooldownStatus(challengeId: number, options?: { enabled?: boolean }) {
  const { enabled = true } = options ?? {};

  return trpc.challenge.getWinnerCooldownStatus.useQuery(
    { challengeId },
    { enabled: enabled && challengeId > 0 }
  );
}
