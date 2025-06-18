import { BuzzWithdrawalRequestStatus } from '~/shared/utils/prisma/enums';

export const WithdrawalRequestBadgeColor = {
  [BuzzWithdrawalRequestStatus.Requested]: 'yellow',
  [BuzzWithdrawalRequestStatus.Approved]: 'blue',
  [BuzzWithdrawalRequestStatus.Transferred]: 'green',
  [BuzzWithdrawalRequestStatus.Canceled]: 'gray',
  [BuzzWithdrawalRequestStatus.Rejected]: 'red',
  [BuzzWithdrawalRequestStatus.Reverted]: 'orange',
  [BuzzWithdrawalRequestStatus.ExternallyResolved]: 'lime',
};
