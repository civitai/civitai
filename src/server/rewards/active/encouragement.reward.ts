import { ReactionEntityType } from '~/server/schema/reaction.schema';
import { createBuzzEvent } from '../base.reward';

export const encouragementReward = createBuzzEvent({
  type: 'encouragement',
  description: 'For encouraging others to post content',
  triggerDescription: 'For each unique reaction you give',
  tooltip:
    "If you react to the same thing multiple times, you will not get more rewards.",
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
