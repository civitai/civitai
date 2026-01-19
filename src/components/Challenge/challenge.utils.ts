import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';
import type { GetInfiniteChallengesInput } from '~/server/schema/challenge.schema';
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

  const { data, ...rest } = trpc.challenge.getInfinite.useInfiniteQuery(
    { ...defaultFilters, ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      enabled,
    }
  );

  const challenges = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  return { challenges, ...rest };
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
