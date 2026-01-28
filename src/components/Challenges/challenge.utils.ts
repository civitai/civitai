import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';
import { ChallengeStatus } from '~/shared/utils/prisma/enums';
import { isFutureDate, startOfDay } from '~/utils/date-helpers';

export const useQueryChallenges = () => {
  const { data, isLoading, isRefetching } = trpc.dailyChallenge.getAll.useQuery();
  return { challenges: data?.items ?? [], loading: isLoading || isRefetching };
};

/**
 * @deprecated Use useGetActiveChallenges() instead, which uses the new Challenge table
 * and supports multiple concurrent challenges.
 */
export const useQueryCurrentChallenge = () => {
  const { data, isLoading } = trpc.dailyChallenge.getCurrent.useQuery(undefined, {
    staleTime: Infinity,
    cacheTime: Infinity,
  });
  return { challenge: data, loading: isLoading };
};

export type ChallengeDetails = ReturnType<typeof useGetActiveChallenges>['challenges'][number];

/**
 * Get active challenges from the new Challenge table.
 * Shows max 2 challenges with "View more" link when more exist.
 */
export function useGetActiveChallenges() {
  const dismissed = useStore((state) => state.dismissed);

  // Use new challenge endpoint with Active status filter
  const { data, isLoading } = trpc.challenge.getInfinite.useQuery(
    { status: [ChallengeStatus.Active], limit: 2 },
    { staleTime: 60 * 1000 } // 1 minute cache
  );

  const challenges = useMemo(() => {
    if (!data?.items) return [];

    return data.items.map((challenge) => ({
      // New Challenge table fields
      challengeId: challenge.id,
      // Legacy fields for backward compatibility
      articleId: 0, // No longer used for navigation
      date: challenge.endsAt,
      resources: challenge.modelVersionIds?.map((id) => ({
        id,
        modelId: challenge.model?.id ?? 0,
      })),
      engine: undefined, // Not applicable for new challenges yet
      collectionId: challenge.collectionId ?? 0,
      title: challenge.title,
      invitation: '', // Detail needs to be fetched separately
      coverUrl: challenge.coverImage?.url ?? '',
      judge: 'ai' as 'ai' | 'team', // Default to AI for system challenges
      dismissed: dismissed.includes(challenge.id),
      endsToday: !isFutureDate(startOfDay(challenge.endsAt)),
      // Creator info for profile picture display
      createdBy: challenge.createdBy,
    }));
  }, [data?.items, dismissed]);

  return {
    challenges,
    loading: isLoading,
    hasMore: !!data?.nextCursor || (data?.items?.length ?? 0) > 2,
  };
}

const useStore = create<{ dismissed: number[] }>()(
  persist(() => ({ dismissed: [] as number[] }), { name: 'challenges', version: 2 })
);

/**
 * Dismiss challenges by ID (now uses challengeId instead of articleId)
 */
export function dismissChallenges(ids: number | number[]) {
  useStore.setState((state) => ({ dismissed: [...new Set(state.dismissed.concat(ids))] }));
}
