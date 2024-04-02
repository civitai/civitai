import { createBuzzEvent } from '../base.reward';

export const dailyBoostReward = createBuzzEvent({
  type: 'dailyBoost',
  description: 'For claiming daily boost rewards',
  triggerDescription: 'By claiming it daily in the Image generator',
  awardAmount: 50,
  cap: 50,
  onDemand: true,
  getKey: async (input: DailyBoostInput) => {
    return {
      toUserId: input.userId,
      forId: input.userId,
      byUserId: input.userId,
      type: `dailyBoost`,
    };
  },
});

type DailyBoostInput = {
  userId: number;
};
