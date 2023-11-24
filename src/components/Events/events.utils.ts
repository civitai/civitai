import { trpc } from '~/utils/trpc';
import { EventInput } from '~/server/schema/event.schema';

export const useQueryEvent = ({ event }: EventInput) => {
  const { data: teamScores = [], isLoading: loadingScores } = trpc.event.getTeamScores.useQuery({
    event,
  });
  const { data: teamScoresHistory = [], isLoading: loadingHistory } =
    trpc.event.getTeamScoreHistory.useQuery({
      event,
      window: 'day',
    });
  const { data: eventCosmetic, isLoading: loadingCosmetic } = trpc.event.getCosmetic.useQuery({
    event,
  });

  return {
    teamScores,
    teamScoresHistory,
    eventCosmetic,
    loading: loadingScores || loadingCosmetic,
    loadingHistory,
  };
};

export const useMutateEvent = () => {
  const queryUtils = trpc.useContext();

  const activateCosmeticMutation = trpc.event.activateCosmetic.useMutation({
    onSuccess: async (_, payload) => {
      await queryUtils.event.getCosmetic.invalidate({ event: payload.event });
    },
  });
  const donateMutation = trpc.event.donate.useMutation({
    onSuccess: async (result, payload) => {
      queryUtils.event.getTeamScores.setData({ event: payload.event }, (old) => {
        if (!old) return old;

        return old.map((teamScore) =>
          teamScore.team === result.team
            ? { ...teamScore, score: teamScore.score + payload.amount }
            : teamScore
        );
      });
    },
  });

  const handleActivateCosmetic = (payload: EventInput) => {
    return activateCosmeticMutation.mutateAsync(payload);
  };

  const handleDonate = (payload: EventInput & { amount: number }) => {
    return donateMutation.mutateAsync(payload);
  };

  return {
    activateCosmetic: handleActivateCosmetic,
    donate: handleDonate,
    equipping: activateCosmeticMutation.isLoading,
    donating: donateMutation.isLoading,
  };
};
