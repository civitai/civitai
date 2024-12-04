import { trpc } from '~/utils/trpc';

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
