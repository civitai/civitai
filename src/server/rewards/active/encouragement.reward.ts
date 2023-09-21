import { ReactionEntityType } from '~/server/schema/reaction.schema';
import { createBuzzEvent } from '../base.reward';

export const encouragementReward = createBuzzEvent({
  type: 'encouragement',
  description: 'For encouraging others to post content',
  awardAmount: 5,
  cap: 100,
  onDemand: true,
  getKey: async (input: ReactionEvent) => {
    return {
      toUserId: input.reactorId,
      forId: input.entityId,
      byUserId: input.reactorId,
      type: `encouragement:${input.type}`,
    };
  },
});

type ReactionEvent = {
  type: ReactionEntityType;
  reactorId: number;
  entityId: number;
};
