import { useIsMutating } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
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
import { AddImageRatingInput, GetHistoryInput } from '~/server/schema/games/new-order.schema';
import { browsingLevels } from '~/shared/constants/browsingLevel.constants';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const JudgementHistoryModal = dynamic(() => import('./NewOrder/JudgementHistory'));

// TODO.newOrder: complete signal setup
export const useKnightsNewOrderListener = () => {
  const queryUtils = trpc.useUtils();

  useSignalTopic(SignalTopic.NewOrderPlayer);
  useSignalTopic(SignalTopic.NewOrderQueue);

  // Used to update player stats (exp, fervor, blessed buzz, rank, etc.)
  useSignalConnection(SignalMessages.NewOrderPlayerUpdate, (data) => {
    queryUtils.games.newOrder.getPlayer.setData(undefined, (old) => {
      if (!old) return old;

      return { ...old, ...data };
    });
  });

  // Used to update the current image queue
  useSignalConnection(SignalMessages.NewOrderQueueUpdate, (data) => {
    queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
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

      const prev = queryUtils.games.newOrder.getImagesQueue.getData();
      queryUtils.games.newOrder.getImagesQueue.setData(undefined, (old) => {
        if (!old) return old;

        return old.filter((image) => image.id !== payload.imageId);
      });

      return { prev };
    },
    onError: (error, _variables, context) => {
      showErrorNotification({ title: 'Failed to send rating', error: new Error(error.message) });
      if (context?.prev) queryUtils.games.newOrder.getImagesQueue.setData(undefined, context.prev);
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

export const openJudgementHistoryModal = () =>
  dialogStore.trigger({ component: JudgementHistoryModal });
