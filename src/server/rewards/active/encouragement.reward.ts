import { ReactionEntityType } from '~/server/schema/reaction.schema';
import { createBuzzEvent } from '../base.reward';

export const encouragementReward = createBuzzEvent({
  type: 'encouragement',
  description: 'For encouraging others to post content',
  triggerDescription: 'For each reaction you give',
  awardAmount: 5,
  cap: 100,
  onDemand: true,
  getKey: async (input: ReactionEvent) => {
    if (input.ownerId === input.reactorId) return false;

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
  ownerId?: number;
};
