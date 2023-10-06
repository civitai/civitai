import { createBuzzEvent } from '../base.reward';

const type = 'userReferred' as const;
export const userReferredReward = createBuzzEvent({
  type,
  description: 'You have referred another user',
  awardAmount: 500,
  onDemand: true,
  triggerDescription: 'For each person you refer',
  tooltip:
    'In your profile, you can create referral codes to invite users to join the platform. Users created with your referral codes and you will both get 500 buzz upon succesful signup.',
  getKey: async (input: userReferredEvent) => {
    return {
      toUserId: input.referrerId,
      byUserId: input.refereeId,
      forId: input.referrerId,
      type: `${type}`,
    };
  },
});

type userReferredEvent = {
  refereeId: number;
  referrerId: number;
};
