import { constants } from '~/server/common/constants';
import { createBuzzEvent } from '../base.reward';

const type = 'reportAccepted' as const;
export const reportAcceptedReward = createBuzzEvent({
  type,
  toAccountType: 'blue',
  description: 'For each report you make that is accepted',
  awardAmount: 50,
  caps: [{ amount: 1500, interval: 'month', keyParts: ['toUserId'] }],
  getKey: async (input: ReportEvent) => {
    // The system account files reports on Civitai's behalf; an accepted one earns nobody Buzz.
    if (input.userId === constants.system.user.id) return false;
    return {
      toUserId: input.userId,
      forId: input.reportId,
      byUserId: input.userId,
      type,
    };
  },
});

type ReportEvent = {
  reportId: number;
  userId: number;
};
