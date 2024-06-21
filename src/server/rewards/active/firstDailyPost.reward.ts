import { createBuzzEvent } from '../base.reward';

export const firstDailyPostReward = createBuzzEvent({
  type: 'firstDailyPost',
  description: 'You made your first post of the day',
  triggerDescription: 'For the first image post you make each day',
  awardAmount: 25,
  cap: 25,
  onDemand: true,
  getKey: async (input: PostEvent) => {
    return {
      toUserId: input.posterId,
      forId: input.postId,
      byUserId: input.posterId,
      type: `firstDailyPost`,
    };
  },
});

type PostEvent = {
  postId: number;
  posterId: number;
};
