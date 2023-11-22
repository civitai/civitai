import { trpc } from '~/utils/trpc';
import { EventInput } from '~/server/schema/event.schema';

export const useQueryEvent = ({ event }: EventInput) => {
  const { data: teamScores, isLoading: loadingScores } = trpc.event.getTeamScores.useQuery({
    event,
  });
  const { data: eventCosmetic, isLoading: loadingCosmetic } = trpc.event.getCosmetic.useQuery({
    event,
  });

  return {
    teamScores,
    eventCosmetic,
    loading: loadingScores || loadingCosmetic,
  };
};

export const useMutateEvent = () => {
  const queryUtils = trpc.useContext();

  const activateCosmeticMutation = trpc.event.activateCosmetic.useMutation({
    onSuccess: async (result, payload) => {
      await queryUtils.event.getCosmetic.invalidate({ event: payload.event });
    },
  });
  const donateMutation = trpc.event.donate.useMutation({
    // TODO.events: optimistic update team scores
    onSuccess: async (_, payload) => {
      await queryUtils.event.getTeamScores.invalidate({ event: payload.event });
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
