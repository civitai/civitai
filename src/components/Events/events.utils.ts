import { trpc } from '~/utils/trpc';
import type { EventInput } from '~/server/schema/event.schema';
import dayjs from '~/shared/utils/dayjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const useQueryEvent = ({ event }: EventInput) => {
  const currentUser = useCurrentUser();
  const { data: eventData, isLoading: loadingData } = trpc.event.getData.useQuery(
    { event },
    { enabled: !!event }
  );
  const { data: teamScores = [], isLoading: loadingScores } = trpc.event.getTeamScores.useQuery(
    { event },
    { enabled: !!event, trpc: { context: { skipBatch: true } } }
  );
  const ended = eventData && eventData.endDate < new Date();
  const window = ended ? 'day' : 'hour';
  const start =
    ended && eventData ? eventData.startDate : dayjs().subtract(3, 'days').startOf('hour').toDate();

  const { data: teamScoresHistory = [], isLoading: loadingHistory } =
    trpc.event.getTeamScoreHistory.useQuery(
      { event, window, start },
      { enabled: !!eventData, trpc: { context: { skipBatch: true } } }
    );
  const { data: eventCosmetic, isInitialLoading: loadingCosmetic } =
    trpc.event.getCosmetic.useQuery({ event }, { enabled: !!currentUser && !!event });
  const { data: rewards = [], isLoading: loadingRewards } = trpc.event.getRewards.useQuery(
    { event },
    { enabled: !!event, trpc: { context: { skipBatch: true } } }
  );
  const { data: userRank, isLoading: loadingUserRank } = trpc.event.getUserRank.useQuery(
    { event },
    {
      enabled:
        !!currentUser &&
        !!event &&
        eventCosmetic?.available &&
        eventCosmetic?.obtained &&
        eventCosmetic?.equipped,
    }
  );
  const { data: partners, isLoading: loadingPartners } = trpc.event.getPartners.useQuery(
    { event },
    { enabled: !!event, trpc: { context: { skipBatch: true } } }
  );

  return {
    eventData,
    teamScores,
    teamScoresHistory,
    eventCosmetic,
    rewards,
    userRank,
    partners,
    loading: loadingScores || loadingCosmetic || loadingData,
    loadingHistory,
    loadingRewards,
    loadingUserRank,
    loadingPartners,
  };
};
export type EventPartners = ReturnType<typeof useQueryEvent>['partners'];

export const useMutateEvent = () => {
  const queryUtils = trpc.useUtils();

  const activateCosmeticMutation = trpc.event.activateCosmetic.useMutation({
    onSuccess: async (_, payload) => {
      await queryUtils.event.getCosmetic.invalidate({ event: payload.event });
    },
  });
  const donateMutation = trpc.event.donate.useMutation({
    onSuccess: async (result, payload) => {
      if (!result) return;

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

export const useQueryEventContributors = ({ event }: { event: string }) => {
  const { data: contributors, isLoading } = trpc.event.getDonors.useQuery(
    { event },
    { trpc: { context: { skipBatch: true } } }
  );

  return { contributors, loading: isLoading };
};
