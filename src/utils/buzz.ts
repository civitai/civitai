import { constants } from '~/server/common/constants';
import type { BuzzTransactionDetails } from '~/server/schema/buzz.schema';

export const parseBuzzTransactionDetails = (
  details?: BuzzTransactionDetails
): { url?: string; notification?: string; label?: string } => {
  if (!details) {
    return {
      url: undefined,
      notification: undefined,
      label: undefined,
    };
  }

  const fallbackUrl = details.user && details.user !== 'a user' ? `/user/${details.user}` : '';
  const baseNotification = `You received a tip of ${String(details.amount)} Buzz from ${
    details.user ? `@${details.user}` : 'a user'
  }`;

  if (!details.entityId || !details.entityType) {
    return {
      url: fallbackUrl,
      notification: `${baseNotification}!`,
      label: 'User',
    };
  }

  const { entityId, entityType } = details;

  const map: Record<string, { url: string; notification: string; label: string }> = {
    default: {
      url: fallbackUrl,
      notification: `${baseNotification}!`,
      label: 'User',
    },
    Model: {
      url: `/models/${entityId}`,
      notification: `${baseNotification} on one of your models!`,
      label: 'Model',
    },
    Image: {
      url: `/images/${entityId}`,
      notification: `${baseNotification} on one of your images!`,
      label: 'Image',
    },
    Comment: {
      url: fallbackUrl,
      notification: `${baseNotification} on one of your comments!`,
      label: 'Comment',
    },
    CommentV2: {
      url: fallbackUrl,
      notification: `${baseNotification} on one of your comments!`,
      label: 'Comment',
    },
    Article: {
      url: `/articles/${entityId}`,
      notification: `${baseNotification} on one of your articles!`,
      label: 'Article',
    },
    Bounty: {
      url: `/bounties/${entityId}`,
      label: 'Bounty',
      notification: '', // Bounties won't be used for notifications thus far.
    },
  };

  return map[entityType] ?? map.default;
};

export const getBuzzWithdrawalDetails = (buzzAmount: number, platformFeeRate?: number) => {
  if (!platformFeeRate) {
    platformFeeRate = constants.buzz.platformFeeRate;
  }
  const dollarAmount = Math.round((buzzAmount / constants.buzz.buzzDollarRatio) * 100);
  const platformFee = Math.round(dollarAmount * (platformFeeRate / 10000));
  const payoutAmount = dollarAmount - platformFee;

  return {
    dollarAmount,
    platformFee,
    payoutAmount,
  };
};

export const usdcToBuzz = (usdcAmount: number): number => {
  // USDC amount is the actual dollar value (e.g., 5.00 for $5)
  // 1 USDC = 1000 Buzz
  return Math.floor(usdcAmount * constants.buzz.buzzDollarRatio);
};

export const buzzToUsdc = (buzzAmount: number): number => {
  // Returns USDC amount (e.g., 5.00 for 5000 Buzz)
  return buzzAmount / constants.buzz.buzzDollarRatio;
};
