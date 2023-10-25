import { createBuzzEvent } from '../base.reward';

const type = 'reportAccepted' as const;
export const reportAcceptedReward = createBuzzEvent({
  type,
  description: 'For each report you make that is accepted',
  awardAmount: 5,
  cap: 25,
  onDemand: true,
  getKey: async (input: PostEvent) => {
    return {
      toUserId: input.userId,
      forId: input.reportId,
      byUserId: input.userId,
      type,
    };
  },
});

type PostEvent = {
  reportId: number;
  userId: number;
};
