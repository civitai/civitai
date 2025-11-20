import type { InfiniteData } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { newOrderConfig } from '~/server/common/constants';
import {
  NewOrderSignalActions,
  NewOrderDamnedReason,
  NsfwLevel,
  SignalMessages,
  SignalTopic,
} from '~/server/common/enums';
import type {
  AddImageRatingInput,
  GetImagesQueueSchema,
} from '~/server/schema/games/new-order.schema';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import type { GetImagesQueueItem, GetPlayersItem } from '~/types/router';
import {
  showErrorNotification,
  showInfoNotification,
  showWarningNotification,
  showSuccessNotification,
} from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';
import produce from 'immer';
import { getQueryKey } from '@trpc/react-query';

// Lazy load modal components to break circular dependency
const JudgmentHistoryModal = dynamic(() => import('./NewOrder/JudgmentHistory'));
const PlayersDirectoryModal = dynamic(() => import('./NewOrder/PlayersDirectoryModal'));
const RatingGuideModal = dynamic(() => import('./NewOrder/NewOrderRatingGuideModal'));
const CareerResetModal = dynamic(() => import('./NewOrder/CareerResetModal'));

type PlayerUpdateStatsPayload = {
  action: NewOrderSignalActions.UpdateStats | NewOrderSignalActions.Reset;
  stats: { exp: number; fervor: number; blessedBuzz: number; smites: number };
  notification?: {
    type: 'smite' | 'reset' | 'warning' | 'cleanse';
    message: string;
    title: string;
  };
};

type PlayerRankUpPayload = {
  action: NewOrderSignalActions.RankUp;
  rankType: NewOrderRankType;
  rank: { type: NewOrderRankType; name: string; iconUrl: string };
};

type PlayerUpdatePayload = PlayerUpdateStatsPayload | PlayerRankUpPayload;

type QueueUpdateAddPayload = {
  action: NewOrderSignalActions.AddImage;
  images: GetImagesQueueItem[];
};
type QueueUpdateRemovePayload = { action: NewOrderSignalActions.RemoveImage; imageId: number };
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
        // Display notification if present
        if (data.notification) {
          const notification = { ...data.notification, autoClose: 5000 };
          switch (data.notification.type) {
            case 'warning':
              showWarningNotification(notification);
              break;
            case 'cleanse':
              showSuccessNotification(notification);
              break;
            case 'smite':
            default:
              showInfoNotification(notification);
              break;
          }
        }

        queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
          if (!old) return old;

          const { exp, ...updatedStats } = data.stats;
          return { ...old, stats: { ...old.stats, ...updatedStats } };
        });
        break;
      case NewOrderSignalActions.Reset:
        // Show modal for career reset
        if (data.notification) {
          dialogStore.trigger({
            component: CareerResetModal,
            props: {
              title: data.notification.title,
              message: data.notification.message,
            },
          });
        }

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
      case NewOrderSignalActions.AddImage:
        queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
          if (!old) return old;
          return [...old, ...data.images];
        });
        break;
      case NewOrderSignalActions.RemoveImage:
        queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
          if (!old) return old;
          const imageIndex = old.findIndex((image) => image.id === data.imageId);
          if (imageIndex <= 0) return old; // Prevents removing the image if the user is rating it

          return produce(old, (draft) => {
            draft.splice(imageIndex, 1);
          });
        });
        break;
      default:
        break;
    }
  });
};

export const useQueryKnightsNewOrderImageQueue = (
  filter?: GetImagesQueueSchema,
  opts?: { enabled?: boolean }
) => {
  // Note: useJoinKnightsNewOrder is now in NewOrder/hooks/useJoinKnightsNewOrder.ts
  // to avoid circular dependency with component modals
  const { data = [], ...rest } = trpc.games.newOrder.getImagesQueue.useQuery(filter, {
    ...opts,
    enabled: opts?.enabled !== false,
  });

  return { data, ...rest };
};

export const useAddImageRating = (opts?: { filters?: GetImagesQueueSchema }) => {
  const queryUtils = trpc.useUtils();
  const addRatingMutation = trpc.games.newOrder.addRating.useMutation({
    onMutate: async (payload) => {
      await queryUtils.games.newOrder.getImagesQueue.cancel();
      await queryUtils.games.newOrder.getPlayer.cancel();

      const prevQueue = queryUtils.games.newOrder.getImagesQueue.getData(opts?.filters);
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
              (matchedImage && isCorrectRating) ||
              prevPlayerData?.rankType !== NewOrderRankType.Acolyte
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

  const addSanityCheckRatingMutation = trpc.games.newOrder.addSanityCheckRating.useMutation({
    onMutate: async (payload) => {
      await queryUtils.games.newOrder.getImagesQueue.cancel();

      queryUtils.games.newOrder.getImagesQueue.setData(opts?.filters, (old) => {
        if (!old) return old;
        return old.filter((image) => image.id !== payload.imageId);
      });
    },
    onError: (error) => {
      showErrorNotification({ title: 'Failed to send rating', error: new Error(error.message) });
    },
  });

  const handleAddRating = (input: Omit<AddImageRatingInput, 'playerId'>) => {
    // Check if this is a sanity check image
    const prevQueue = queryUtils.games.newOrder.getImagesQueue.getData(opts?.filters);
    const matchedImage = prevQueue?.find((image) => image.id === input.imageId);
    const isSanityCheck = matchedImage?.metadata?.isSanityCheck === true;

    if (isSanityCheck) {
      // Use sanity check endpoint (only imageId and rating, no damnedReason)
      return addSanityCheckRatingMutation.mutateAsync({
        imageId: input.imageId,
        rating: input.rating,
      });
    }

    // Use regular rating endpoint
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
    isLoading: addRatingMutation.isLoading || addSanityCheckRatingMutation.isLoading,
    skipRating: handleSkipImage,
  };
};

export const ratingOptions = [...browsingLevels, NsfwLevel.Blocked];

export const damnedReasonOptions = [
  NewOrderDamnedReason.InappropriateMinors,
  NewOrderDamnedReason.RealisticMinors,
  NewOrderDamnedReason.DepictsRealPerson,
  NewOrderDamnedReason.Bestiality,
  NewOrderDamnedReason.Other,
] as const;

export const ratingPlayBackRates: Record<string, number> = {
  [NsfwLevel.PG]: 1.4,
  [NsfwLevel.PG13]: 1.2,
  [NsfwLevel.R]: 1,
  [NsfwLevel.X]: 0.8,
  [NsfwLevel.XXX]: 0.7,
  [NsfwLevel.Blocked]: 1,
};

export const openJudgmentHistoryModal = () =>
  dialogStore.trigger({ component: JudgmentHistoryModal });

export const openPlayersDirectoryModal = () =>
  dialogStore.trigger({ component: PlayersDirectoryModal });

export const openRatingGuideModal = () => dialogStore.trigger({ component: RatingGuideModal });

export const useQueryImageRaters = ({ imageId }: { imageId: number }) => {
  const currentUser = useCurrentUser();
  const { data, ...rest } = trpc.games.newOrder.getImageRaters.useQuery(
    { imageId },
    { enabled: !!currentUser?.isModerator }
  );

  return {
    raters: data ?? { [NewOrderRankType.Knight]: [], [NewOrderRankType.Templar]: [] },
    ...rest,
  };
};
