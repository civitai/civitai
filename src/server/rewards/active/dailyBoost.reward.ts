import dayjs from 'dayjs';
import { createBuzzEvent } from '../base.reward';

export const dailyBoostReward = createBuzzEvent({
  type: 'dailyBoost',
  description: 'For claiming daily boost rewards',
  triggerDescription: 'By claiming it daily in the Image generator',
  awardAmount: 50,
  cap: 50,
  onDemand: true,
  getKey: async (input: DailyBoostInput) => {
    const date = dayjs().startOf('day').format('YYYY-MM-DD');
    return {
      toUserId: input.userId,
      forId: date,
      byUserId: input.userId,
      type: `dailyBoost`,
    };
  },
});

type DailyBoostInput = {
  userId: number;
};
