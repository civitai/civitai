import { InfiniteData, useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useStorage } from '~/hooks/useStorage';
import { newOrderConfig } from '~/server/common/constants';
import {
  NewOrderSignalActions,
  NewOrderDamnedReason,
  NsfwLevel,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import {
  AddImageRatingInput,
  GetHistoryInput,
  GetImagesQueueSchema,
  GetPlayersInfiniteSchema,
} from '~/server/schema/games/new-order.schema';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { GetImagesQueueItem, GetPlayersItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

const JudgmentHistoryModal = dynamic(() => import('./NewOrder/JudgmentHistory'));
const PlayersDirectoryModal = dynamic(() => import('./NewOrder/PlayersDirectoryModal'));

type PlayerUpdateStatsPayload = {
  action: NewOrderSignalActions.UpdateStats | NewOrderSignalActions.Reset;
  stats: { exp: number; fervor: number; blessedBuzz: number; smites: number };
};

type PlayerRankUpPayload = {
  action: NewOrderSignalActions.RankUp;
  rankType: NewOrderRankType;
  rank: { type: NewOrderRankType; name: string; iconUrl: string };
};

type PlayerUpdatePayload = PlayerUpdateStatsPayload | PlayerRankUpPayload;

type QueueUpdateAddPayload = { action: 'add'; images: GetImagesQueueItem[] };
type QueueUpdateRemovePayload = { action: 'remove'; imageId: number };
type QueueUpdatePayload = QueueUpdateAddPayload | QueueUpdateRemovePayload;

export const useKnightsNewOrderListener = ({
  onRankUp,
  onReset,
}: {
  onRankUp?: (rank: { type: NewOrderRankType; name: string }) => void;
  onReset?: VoidFunction;
} = {}) => {
  const queryUtils = trpc.useUtils();

  const { playerData } = useJoinKnightsNewOrder();

  // TODO.newOrder: rename this topic for global signals
  // useSignalTopic(SignalTopic.NewOrderPlayer);
  useSignalTopic(
    playerData ? `${SignalTopic.NewOrderQueue}:${playerData.rankType}` : undefined,
    true
  );

  // Used to update player stats (exp, fervor, blessed buzz, rank, etc.)
  useSignalConnection(SignalMessages.NewOrderPlayerUpdate, async (data: PlayerUpdatePayload) => {
    switch (data.action) {
      case NewOrderSignalActions.UpdateStats:
        queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
          if (!old) return old;
          return { ...old, stats: { ...old.stats, ...data.stats } };
        });
        break;
      case 'reset':
        onReset?.();
        queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
          if (!old) return old;
          return { ...old, stats: { ...old.stats, exp: 0, fervor: 0, blessedBuzz: 0, smites: 0 } };
        });

        await Promise.all([
          queryUtils.games.newOrder.getImagesQueue.invalidate(),
          queryUtils.games.newOrder.getPlayer.invalidate(),
          queryUtils.games.newOrder.getHistory.invalidate(),
        ]);
        break;
      case NewOrderSignalActions.RankUp:
        onRankUp?.(data.rank);
        queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
          if (!old) return old;
          return { ...old, rankType: data.rankType, rank: data.rank };
        });

        await Promise.all([
          queryUtils.games.newOrder.getImagesQueue.invalidate(),
          queryUtils.games.newOrder.getPlayer.invalidate(),
        ]);
        break;
      default:
        break;
    }
  });

  // Used to update the current image queue
  useSignalConnection(SignalMessages.NewOrderQueueUpdate, (data: QueueUpdatePayload) => {
    switch (data.action) {
      case 'add':
        queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
          if (!old) return old;
          return [...old, ...data.images];
        });
        break;
      case 'remove':
        queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
          if (!old) return old;
          return old.filter((image) => image.id !== data.imageId);
        });
        break;
      default:
        break;
    }
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
    retry: 1,
    onError: (error) => {
      setJoined(false);
      showErrorNotification({
        title: 'Failed to load player data',
        error: new Error(error.message),
      });
    },
  });

  const resetCareerMutation = trpc.games.newOrder.resetCareer.useMutation({
    onSuccess: async () => {
      await Promise.all([
        queryUtils.games.newOrder.getPlayer.invalidate(),
        queryUtils.games.newOrder.getImagesQueue.invalidate(),
        queryUtils.games.newOrder.getHistory.invalidate(),
      ]);
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

export const useQueryKnightsNewOrderImageQueue = (
  filter?: GetImagesQueueSchema,
  opts?: { enabled?: boolean }
) => {
  const { playerData } = useJoinKnightsNewOrder();

  const { data = [], ...rest } = trpc.games.newOrder.getImagesQueue.useQuery(filter, {
    ...opts,
    enabled: !!playerData && opts?.enabled !== false,
  });

  return { data, ...rest };
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

export const useAddImageRating = (opts?: { filters?: GetImagesQueueSchema }) => {
  const queryUtils = trpc.useUtils();
  const addRatingMutation = trpc.games.newOrder.addRating.useMutation({
    onMutate: async (payload) => {
      await queryUtils.games.newOrder.getImagesQueue.cancel();
      await queryUtils.games.newOrder.getPlayer.cancel();

      const prevQueue = queryUtils.games.newOrder.getImagesQueue.getData();
      queryUtils.games.newOrder.getImagesQueue.setData(opts?.filters, (old) => {
        if (!old) return old;

        return old.filter((image) => image.id !== payload.imageId);
      });

      const prevPlayerData = queryUtils.games.newOrder.getPlayer.getData();
      queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
        if (!old) return old;

        const matchedImage = prevQueue?.find((image) => image.id === payload.imageId);
        const isCorrectRating = matchedImage?.nsfwLevel === payload.rating;

        return {
          ...old,
          stats: {
            ...old.stats,
            exp:
              matchedImage && isCorrectRating
                ? old.stats.exp + newOrderConfig.baseExp
                : old.stats.exp,
          },
        };
      });

      return { prevQueue, prevPlayerData };
    },
    onError: (error, _variables, context) => {
      showErrorNotification({ title: 'Failed to send rating', error: new Error(error.message) });
      if (context) {
        // We are not going to revert the image queue to allow the user to keep rating
        queryUtils.games.newOrder.getPlayer.setData(undefined, context.prevPlayerData);
      }
    },
  });

  const handleAddRating = (input: Omit<AddImageRatingInput, 'playerId'>) => {
    return addRatingMutation.mutateAsync(input);
  };

  const handleSkipImage = async ({ imageId }: { imageId: number }) => {
    await queryUtils.games.newOrder.getImagesQueue.cancel();
    queryUtils.games.newOrder.getImagesQueue.setData(opts?.filters, (old) => {
      if (!old) return old;

      return old.filter((image) => image.id !== imageId);
    });
  };

  return {
    addRating: handleAddRating,
    isLoading: addRatingMutation.isLoading,
    skipRating: handleSkipImage,
  };
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
    onSuccess: async (_, payload) => {
      if (payload.imageId) {
        queryUtils.games.newOrder.getImageRaters.setData(
          { imageId: payload.imageId },
          produce((old) => {
            if (!old) return old;

            // Remove the rating from both Knight and Templar lists
            for (const rankType of [NewOrderRankType.Knight, NewOrderRankType.Templar]) {
              const ratings = old[rankType];
              if (Array.isArray(ratings)) {
                old[rankType] = ratings.filter((r) => r.player.id !== payload.playerId);
              }
            }

            return old;
          })
        );
      } else {
        await queryUtils.games.newOrder.getImageRaters.invalidate();
      }
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

  const resetPlayerMutation = trpc.games.newOrder.resetPlayerById.useMutation({
    onSuccess: async () => {
      await queryUtils.games.newOrder.getPlayers.invalidate();
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to reset player', error: new Error(error.message) });
    },
  });

  return {
    smitePlayer: smitePlayerMutation.mutate,
    smitePayload: smitePlayerMutation.variables,
    cleanseSmite: cleanseSmiteMutation.mutate,
    cleansePayload: cleanseSmiteMutation.variables,
    applyingSmite: smitePlayerMutation.isLoading,
    cleansingSmite: cleanseSmiteMutation.isLoading,
    resetPlayer: resetPlayerMutation.mutate,
    resettingPlayer: resetPlayerMutation.isLoading,
    resetPayload: resetPlayerMutation.variables,
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

export const useQueryImageRaters = ({ imageId }: { imageId: number }) => {
  const { data, ...rest } = trpc.games.newOrder.getImageRaters.useQuery({ imageId });

  return {
    raters: data ?? { [NewOrderRankType.Knight]: [], [NewOrderRankType.Templar]: [] },
    ...rest,
  };
};
