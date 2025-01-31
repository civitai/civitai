import { createBuzzEvent } from '../base.reward';

const type = 'reportAccepted' as const;
export const reportAcceptedReward = createBuzzEvent({
  type,
  toAccountType: 'generation',
  description: 'For each report you make that is accepted',
  awardAmount: 50,
  caps: [{ amount: 1500, interval: 'month', keyParts: ['toUserId'] }],
  getKey: async (input: ReportEvent) => {
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
