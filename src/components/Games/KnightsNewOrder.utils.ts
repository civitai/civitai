import { InfiniteData, useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useStorage } from '~/hooks/useStorage';
import {
  NewOrderDamnedReason,
  NsfwLevel,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import {
  AddImageRatingInput,
  GetHistoryInput,
  GetPlayersInfiniteSchema,
} from '~/server/schema/games/new-order.schema';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { GetPlayersItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

const JudgmentHistoryModal = dynamic(() => import('./NewOrder/JudgmentHistory'));
const PlayersDirectoryModal = dynamic(() => import('./NewOrder/PlayersDirectoryModal'));

export const useKnightsNewOrderListener = () => {
  const queryUtils = trpc.useUtils();

  const { playerData } = useJoinKnightsNewOrder();

  // TODO.newOrder: rename this topic for global signals
  useSignalTopic(SignalTopic.NewOrderPlayer);
  useSignalTopic(playerData ? `${SignalTopic.NewOrderPlayer}:${playerData.id}` : undefined);
  useSignalTopic(playerData ? `${SignalTopic.NewOrderQueue}:${playerData.rankType}` : undefined);

  // Used to update player stats (exp, fervor, blessed buzz, rank, etc.)
  useSignalConnection(SignalMessages.NewOrderPlayerUpdate, (data) => {
    console.log('update player from signal', data);
    queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
      if (!old) return old;

      const { stats, ...rest } = data;
      return { ...old, ...rest, stats: { ...old.stats, ...stats } };
    });
  });

  // Used to update the current image queue
  useSignalConnection(SignalMessages.NewOrderQueueUpdate, (data) => {
    console.log('update queue from signal', data);
    queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
      // TODO.newOrder: Handle removing from queue
      if (!old) return old;

      return [...old, ...data];
    });
  });
};

export const useJoinKnightsNewOrder = () => {
  const queryUtils = trpc.useUtils();
  const [joined, setJoined] = useStorage({
    key: 'joined-kono',
    type: 'localStorage',
    defaultValue: false,
    getInitialValueInEffect: false,
  });

  // Required to share loading state between components
  const joinKey = getQueryKey(trpc.games.newOrder.join);
  const joining = useIsMutating({ mutationKey: joinKey });

  const joinKnightsNewOrderMutation = trpc.games.newOrder.join.useMutation({
    onSuccess: (result) => {
      queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
        setJoined(true);
        if (!old) return result;

        return { ...old, ...result };
      });
    },
  });

  const { data: playerData, isInitialLoading } = trpc.games.newOrder.getPlayer.useQuery(undefined, {
    enabled: joined,
  });

  const resetCareerMutation = trpc.games.newOrder.resetCareer.useMutation({
    onSuccess: async () => {
      await queryUtils.games.newOrder.getPlayer.invalidate();
      await queryUtils.games.newOrder.getImagesQueue.invalidate();
      await queryUtils.games.newOrder.getHistory.invalidate();
    },
  });

  return {
    playerData,
    join: joinKnightsNewOrderMutation.mutateAsync,
    resetCareer: resetCareerMutation.mutateAsync,
    isLoading: isInitialLoading || !!joining,
    resetting: resetCareerMutation.isLoading,
    joined,
  };
};

export const useQueryKnightsNewOrderImageQueue = (opts?: { enabled?: boolean }) => {
  const { playerData } = useJoinKnightsNewOrder();

  const { data = [], isLoading } = trpc.games.newOrder.getImagesQueue.useQuery(undefined, {
    ...opts,
    enabled: !!playerData && opts?.enabled !== false,
  });

  return { data, isLoading };
};
export const useQueryInfiniteKnightsNewOrderHistory = (
  filter?: Partial<GetHistoryInput>,
  opts?: { enabled?: boolean }
) => {
  const { playerData } = useJoinKnightsNewOrder();
  const { data, ...rest } = trpc.games.newOrder.getHistory.useInfiniteQuery(
    { limit: 10, ...filter },
    {
      ...opts,
      enabled: !!playerData && opts?.enabled !== false,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return { images: flatData, ...rest };
};

export const useAddImageRating = () => {
  const queryUtils = trpc.useUtils();
  const addRatingMutation = trpc.games.newOrder.addRating.useMutation({
    onMutate: async (payload) => {
      await queryUtils.games.newOrder.getImagesQueue.cancel();
      await queryUtils.games.newOrder.getPlayer.cancel();

      const prevQueue = queryUtils.games.newOrder.getImagesQueue.getData();
      queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
        if (!old) return old;

        return old.filter((image) => image.id !== payload.imageId);
      });

      const prevPlayerData = queryUtils.games.newOrder.getPlayer.getData();
      queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
        if (!old) return old;

        return {
          ...old,
          stats: {
            ...old.stats,
            exp: old.stats.exp + 100,
          },
        };
      });

      return { prevQueue, prevPlayerData };
    },
    onError: (error, _variables, context) => {
      showErrorNotification({ title: 'Failed to send rating', error: new Error(error.message) });
      if (context) {
        queryUtils.games.newOrder.getImagesQueue.setData(undefined, context.prevQueue);
        queryUtils.games.newOrder.getPlayer.setData(undefined, context.prevPlayerData);
      }
    },
  });

  const handleAddRating = (input: Omit<AddImageRatingInput, 'playerId'>) => {
    return addRatingMutation.mutateAsync(input);
  };

  return { addRating: handleAddRating, isLoading: addRatingMutation.isLoading };
};

export const ratingOptions = [...browsingLevels, NsfwLevel.Blocked];

export const damnedReasonOptions = [
  NewOrderDamnedReason.InappropriateMinors,
  NewOrderDamnedReason.RealisticMinors,
  NewOrderDamnedReason.InappropriateRealPerson,
  NewOrderDamnedReason.Bestiality,
  NewOrderDamnedReason.GraphicViolence,
] as const;

export const ratingPlayBackRates: Record<string, number> = {
  [NsfwLevel.PG]: 1.4,
  [NsfwLevel.PG13]: 1.2,
  [NsfwLevel.R]: 1,
  [NsfwLevel.X]: 0.8,
  [NsfwLevel.XXX]: 0.7,
};

export const openJudgmentHistoryModal = () =>
  dialogStore.trigger({ component: JudgmentHistoryModal });

export const openPlayersDirectoryModal = () =>
  dialogStore.trigger({ component: PlayersDirectoryModal });

export const useInquisitorTools = () => {
  const queryUtils = trpc.useUtils();

  const smitePlayerMutation = trpc.games.newOrder.smitePlayer.useMutation({
    onSuccess: (_, payload) => {
      queryUtils.games.newOrder.getImagesQueue.setData(
        undefined,
        produce((old) => {
          if (!old) return old;

          const imageIndex = old.findIndex((image) => image.id === payload.imageId);
          if (imageIndex === -1) return old;

          const image = old[imageIndex];
          image.ratings =
            image.ratings?.filter((rating) => rating.player.id !== payload.playerId) ?? [];
        })
      );
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to smite player', error: new Error(error.message) });
    },
  });

  const cleanseSmiteMutation = trpc.games.newOrder.cleanseSmite.useMutation({
    onSuccess: (_, payload) => {
      const queryKey = getQueryKey(trpc.games.newOrder.getPlayers);
      queryClient.setQueriesData({ queryKey, exact: false }, (state) =>
        produce(
          state,
          (old?: InfiniteData<{ items: GetPlayersItem[]; nextCursor: number | null }>) => {
            if (!old?.pages.length) return old;

            for (const page of old.pages) {
              for (const player of page.items) {
                if (player.id === payload.playerId) {
                  player.stats.smites = player.stats.smites - 1;
                  player.activeSmites =
                    player.activeSmites?.filter((smite) => smite.id !== payload.id) ?? [];
                }
              }
            }
          }
        )
      );
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to cleanse smite', error: new Error(error.message) });
    },
  });

  return {
    smitePlayer: smitePlayerMutation.mutate,
    smitePayload: smitePlayerMutation.variables,
    cleanseSmite: cleanseSmiteMutation.mutate,
    cleansePayload: cleanseSmiteMutation.variables,
    applyingSmite: smitePlayerMutation.isLoading,
    cleansingSmite: cleanseSmiteMutation.isLoading,
  };
};

export const useQueryPlayersInfinite = (
  filters?: Partial<GetPlayersInfiniteSchema>,
  opts?: { enabled?: boolean }
) => {
  const { data, ...rest } = trpc.games.newOrder.getPlayers.useInfiniteQuery(
    { ...filters },
    {
      ...opts,
      enabled: opts?.enabled !== false,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );
  const flatData = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data]);

  return { players: flatData, ...rest };
};
