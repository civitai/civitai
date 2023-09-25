import { createBuzzEvent } from '../base.reward';

const type = 'userReferred' as const;
export const userReferredReward = createBuzzEvent({
  type,
  description: 'You have referred another user',
  awardAmount: 500,
  onDemand: true,
  getKey: async (input: userReferredEvent) => {
    return {
      toUserId: input.referrerId,
      byUserId: input.refereeId,
      forId: input.referrerId,
      type: `${type}`,
    };
  },
});

type userReferredEvent = {
  refereeId: number;
  referrerId: number;
};
