import type { InfiniteData } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { showErrorNotification } from '~/utils/notifications';
import { trpc, queryClient } from '~/utils/trpc';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import type { GetPlayersItem } from '~/types/router';

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
