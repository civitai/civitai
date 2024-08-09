import { createBuzzEvent } from '../base.reward';

export const adWatchedReward = createBuzzEvent({
  type: 'adWatched',
  description: 'For watching ads',
  triggerDescription: 'By watching short ads',
  awardAmount: 50,
  cap: 5,
  onDemand: true,
  getKey: async (input: AdWatchEvent) => {
    return {
      toUserId: input.userId,
      forId: input.token,
      byUserId: input.userId,
      type: 'ad-watched',
    };
  },
});

type AdWatchEvent = {
  token: string;
  userId: number;
};
