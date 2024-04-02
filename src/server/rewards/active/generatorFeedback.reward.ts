import { ReactionEntityType } from '~/server/schema/reaction.schema';
import { createBuzzEvent } from '../base.reward';

export const generatorFeedbackReward = createBuzzEvent({
  type: 'generation-feedback',
  description: 'For giving feedback to images created on the generator',
  triggerDescription: 'For feedback given on the generator',
  awardAmount: 4,
  cap: 40,
  onDemand: true,
  getKey: async (input: FeedbackEvent) => {
    return {
      toUserId: input.userId,
      forId: input.jobId,
      byUserId: input.userId,
      type: `generation-feedback`,
    };
  },
});

type FeedbackEvent = {
  jobId: string;
  userId: number;
};
