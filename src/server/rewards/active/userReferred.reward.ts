import { createBuzzEvent } from '../base.reward';

const type = 'userReferred' as const;
export const userReferredReward = createBuzzEvent({
  type,
  description: 'You have referred another user',
  awardAmount: 500,
  onDemand: true,
  visible: false,
  triggerDescription: 'For each person you refer',
  tooltip:
    "You can create referral codes on your profile page and invite users to join Civitai. When users successfully register a new account with your referral code, you'll both be awarded Buzz.",
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
