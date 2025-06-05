import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';
import { isFutureDate, startOfDay } from '~/utils/date-helpers';

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

export type ChallengeDetails = {
  articleId: number;
  date: Date;
  resources?: { id: number; modelId: number }[];
  engine?: string;
  collectionId: number;
  title: string;
  invitation: string;
  coverUrl: string;
  judge?: 'ai' | 'team';
  dismissed?: boolean;
  endsToday?: boolean;
};

export const customChallenges: ChallengeDetails[] = [
  {
    articleId: 13668,
    date: new Date('2025-05-06T23:59:59.999Z'),
    judge: 'team',
    engine: 'hunyuan',
    collectionId: 9405834,
    title: 'Lights, Camera, AI-ction! Hunyuan / Wan 2.1 + Civitai Launch Contest!',
    invitation: `Bring your cinematic genius to the table with our new Lights, Camera, AI-ction Contest - celebrating the launch of Hunyuan & Wan 2.1 video generation models on Civitai!`,
    coverUrl: '9c0d89b2-aa1f-49be-92fd-a2e6fe6f94b9',
  },
];

export function useGetActiveChallenges() {
  const dismissed = useStore((state) => state.dismissed);
  const { data, isLoading } = trpc.dailyChallenge.getCurrent.useQuery(undefined, {
    staleTime: Infinity,
    cacheTime: Infinity,
    onSettled: (data) => {
      const articleIds = [data?.articleId, ...customChallenges.map((x) => x.articleId)].filter(
        isDefined
      );
      const newDismissed = dismissed.filter((dismissedId) => articleIds.includes(dismissedId));
      useStore.setState({ dismissed: newDismissed });
    },
  });
  const challenges = useMemo(() => {
    const now = new Date().getTime();
    const daily = data
      ? { ...data, resources: data.modelVersionIds.map((id) => ({ id, modelId: data.modelId })) }
      : null;
    return [daily, ...customChallenges.filter((x) => x.date.getTime() > now)]
      .filter(isDefined)
      .map((challenge) => ({
        ...challenge,
        dismissed: dismissed.includes(challenge.articleId),
        endsToday: !isFutureDate(startOfDay(challenge.date)),
      }));
  }, [data, dismissed]);

  return { challenges, loading: isLoading };
}

const useStore = create<{ dismissed: number[] }>()(
  persist((set) => ({ dismissed: [] }), { name: 'challenges', version: 1 })
);

export function dismissChallenges(ids: number | number[]) {
  useStore.setState((state) => ({ dismissed: [...new Set(state.dismissed.concat(ids))] }));
}
