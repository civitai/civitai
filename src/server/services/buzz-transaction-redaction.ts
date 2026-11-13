import { TransactionType } from '~/shared/constants/buzz.constants';
import { projectExternalTransactionId } from '~/server/services/blocks/block-buzz-read.projection';

// Reward rows record the user who triggered the reward, both as `details.byUserId` and inside the
// ledger id (`<type>:<forId>-<toUserId>-<byUserId>`, see rewards/base.reward.ts). Neither is ours to
// show the account owner, so reward ids get the same default-deny as the App Blocks projection.
export function redactTransactionCounterparty<
  T extends {
    type: TransactionType;
    details?: Record<string, unknown> | null;
    externalTransactionId?: string | null;
  }
>(transaction: T): T {
  const { details, externalTransactionId, type } = transaction;
  let redactedDetails = details;
  if (details && 'byUserId' in details) {
    const { byUserId: _byUserId, ...rest } = details;
    redactedDetails = rest;
  }

  return {
    ...transaction,
    details: redactedDetails,
    externalTransactionId:
      type === TransactionType.Reward
        ? projectExternalTransactionId(externalTransactionId)
        : externalTransactionId,
  } as T;
}
