import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';

export const useQueryChallenges = () => {
  const { data, isLoading, isRefetching } = trpc.dailyChallenge.getAll.useQuery();
  return { challenges: data?.items ?? [], loading: isLoading || isRefetching };
};

export const useQueryCurrentChallenge = () => {
  const { data, isLoading } = trpc.dailyChallenge.getCurrent.useQuery(undefined, {
    staleTime: Infinity,
    cacheTime: Infinity,
  });
  return { challenge: data, loading: isLoading };
};

export type ChallengeDetails = ReturnType<typeof useGetActiveChallenges>['challenges'][number];
export function useGetActiveChallenges() {
  const dismissed = useStore((state) => state.dismissed);
  const { data, isLoading } = trpc.dailyChallenge.getCurrent.useQuery(undefined, {
    staleTime: Infinity,
    cacheTime: Infinity,
    onSettled: (data) => {
      const articleIds = data?.map((x) => x.articleId).filter(isDefined);
      const newDismissed = dismissed.filter((dismissedId) => articleIds?.includes(dismissedId));
      useStore.setState({ dismissed: newDismissed });
    },
  });
  const challenges = useMemo(() => {
    return (
      data?.map((challenge) => ({
        ...challenge,
        dismissed: dismissed.includes(challenge.articleId),
      })) ?? []
    );
  }, [data, dismissed]);

  return { challenges, loading: isLoading };
}

const useStore = create<{ dismissed: number[] }>()(
  persist((set) => ({ dismissed: [] }), { name: 'challenges', version: 1 })
);

export function dismissChallenges(ids: number | number[]) {
  useStore.setState((state) => ({ dismissed: [...new Set(state.dismissed.concat(ids))] }));
}
