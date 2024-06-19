import { createBuzzEvent } from '../base.reward';

export const firstDailyPostReward = createBuzzEvent({
  type: 'firstDailyPost',
  description: 'You made your first post of the day',
  triggerDescription: 'For the first image post you make each day',
  tooltip: 'If your post does not include a safe image, you will recieve a reduced reward.',
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

export const firstDailyPostNsfwReward = createBuzzEvent({
  type: 'firstDailyPost',
  visible: false,
  description: 'You made your first post of the day (NSFW)',
  triggerDescription: 'For the first image post you make each day (NSFW)',
  awardAmount: 10,
  cap: 10,
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
