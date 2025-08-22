import dayjs from '~/shared/utils/dayjs';
import { createBuzzEvent } from '../base.reward';

export const dailyBoostReward = createBuzzEvent({
  type: 'dailyBoost',
  toAccountType: 'generation',
  description: 'For claiming daily boost rewards',
  triggerDescription: 'By claiming it daily in the Image generator',
  awardAmount: 25,
  cap: 25,
  onDemand: true,
  getKey: async (input: DailyBoostInput) => {
    const date = +dayjs().startOf('day').format('YYYYMMDD');
    return {
      toUserId: input.userId,
      forId: date, // Must be a number
      byUserId: input.userId,
      type: `dailyBoost`,
    };
  },
});

type DailyBoostInput = {
  userId: number;
};
