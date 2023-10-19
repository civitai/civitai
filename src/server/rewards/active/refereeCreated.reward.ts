import { createBuzzEvent } from '../base.reward';

const type = 'refereeCreated' as const;
export const refereeCreatedReward = createBuzzEvent({
  type,
  description: 'You have been referred by another user',
  awardAmount: 500,
  onDemand: true,
  cap: 500,
  visible: false,
  getKey: async (input: RefereeCreatedEvent) => {
    return {
      toUserId: input.refereeId,
      byUserId: input.referrerId,
      forId: input.referrerId,
      type: `${type}`,
    };
  },
});

type RefereeCreatedEvent = {
  refereeId: number;
  referrerId: number;
};
