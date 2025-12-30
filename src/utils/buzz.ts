import { NsfwLevel } from '~/server/common/enums';
import { constants } from '~/server/common/constants';
import type { BuzzTransactionDetails } from '~/server/schema/buzz.schema';
import {
  buzzConstants,
  TransactionType,
  type BuzzSpendType,
} from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { capitalize } from '~/utils/string-helpers';
import { getCurrencyConfig } from '~/shared/constants/currency.constants';

export const parseBuzzTransactionDetails = (
  details?: BuzzTransactionDetails,
  transactionType?: TransactionType
): { url?: string; notification?: string; label?: string } => {
  if (!details) {
    return {
      url: undefined,
      notification: undefined,
      label: undefined,
    };
  }

  const fallbackUrl = details.user && details.user !== 'a user' ? `/user/${details.user}` : '';
  const baseNotification = `You received a tip of ${String(details.amount)} ${capitalize(
    details.toAccountType ?? 'Yellow'
  )} Buzz from ${details.user ? `@${details.user}` : 'a user'}`;

  // Handle training transactions with workflowId (only for Training type, not Generation)
  const workflowId = (details as Record<string, unknown>).workflowId;
  if (
    transactionType === TransactionType.Training &&
    typeof workflowId === 'string' &&
    workflowId
  ) {
    return {
      url: `/training/${workflowId}`,
      notification: '',
      label: 'Training',
    };
  }

  if (!details.entityId || !details.entityType) {
    return {
      url: details.url || fallbackUrl,
      notification: `${baseNotification}!`,
      label: details.url ? 'Details' : 'User',
    };
  }

  const { entityId, entityType, url: detailsUrl } = details;

  const map: Record<string, { url: string; notification: string; label: string }> = {
    default: {
      url: detailsUrl || fallbackUrl,
      notification: `${baseNotification}!`,
      label: detailsUrl ? 'Details' : 'User',
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
    Training: {
      url: `/model-versions/${entityId}`,
      label: 'Training',
      notification: '', // Training transactions don't trigger notifications.
    },
    ModelVersion: {
      url: `/model-versions/${entityId}`,
      label: 'Model Version',
      notification: '',
    },
  };

  return map[entityType] ?? map.default;
};

/**
 * Gets the supported Buzz account types for a transaction based on NSFW level and content rating.
 * Takes a base array of account types that are assumed available and filters based on content.
 *
 * @param data - Configuration object
 * @param data.nsfwLevel - The NSFW level enum value (optional)
 * @param data.isNsfw - Boolean flag indicating if content is NSFW (optional)
 * @param data.baseTypes - Base array of account types to filter from (defaults to all spend types)
 * @returns Array of supported BuzzSpendType values for the transaction
 */
export const getBuzzTransactionSupportedAccountTypes = ({
  nsfwLevel,
  isNsfw,
  baseTypes,
}: {
  nsfwLevel?: NsfwLevel;
  isNsfw?: boolean;
  baseTypes?: BuzzSpendType[];
}): BuzzSpendType[] => {
  const availableTypes = baseTypes ?? ['yellow', 'green', 'red', 'blue'];
  const accountTypes: BuzzSpendType[] = [];

  // For safe content, allow green if available in base types
  if ((typeof isNsfw !== 'undefined' && !isNsfw) || (nsfwLevel ?? 0) <= NsfwLevel.R) {
    if (availableTypes.includes('green')) {
      accountTypes.push('green');
    }
  }

  // Always include yellow if available (universal primary currency)
  if (availableTypes.includes('yellow')) {
    accountTypes.push('yellow');
  }

  // For NSFW content, include red if available
  if ((typeof isNsfw !== 'undefined' && isNsfw) || (nsfwLevel ?? 0) > NsfwLevel.R) {
    if (availableTypes.includes('red')) {
      accountTypes.push('red');
    }
  }

  // Always include blue if available (universal currency)
  if (availableTypes.includes('blue')) {
    accountTypes.push('blue');
  }

  return accountTypes;
};

export type BuzzTypeDistribution = {
  pct: Partial<Record<BuzzSpendType, number>>;
  amt: Partial<Record<BuzzSpendType, number>>;
};

type BuzzBalance = {
  balance: number;
  type: BuzzSpendType;
};

export const getBuzzTypeDistribution = ({
  accounts,
  buzzAmount = 0,
}: {
  accounts: BuzzBalance[];
  buzzAmount: number;
}): BuzzTypeDistribution => {
  const data: BuzzTypeDistribution = {
    // Will fill with relevant account types:
    amt: {},
    pct: {},
  };

  let current = buzzAmount;

  for (const { balance, type } of accounts) {
    data.amt[type] = 0;
    data.pct[type] = 0;

    if (current <= 0 || balance <= 0) continue;

    const taken = Math.min(balance, current);
    data.amt[type] = taken;
    data.pct[type] = taken / buzzAmount;
    current -= taken;
  }

  return data;
};

// Create gradient from distribution
export const createBuzzDistributionGradient = ({
  typeDistribution,
  direction = 'right',
}: {
  typeDistribution?: BuzzTypeDistribution;
  direction?: 'right' | 'left' | 'top' | 'bottom';
}) => {
  if (!typeDistribution) return undefined;

  const entries = Object.entries(typeDistribution.pct).filter(([, pct]) => (pct || 0) > 0);
  if (entries.length <= 1) {
    if (entries.length === 0) return undefined;

    const config = getCurrencyConfig({
      currency: Currency.BUZZ,
      type: entries[0]?.[0] as BuzzSpendType,
    });

    return config.color;
  }

  let currentPct = 0;
  const gradientStops = entries.map(([accountType, pct]) => {
    const typeConfig = getCurrencyConfig({
      currency: Currency.BUZZ,
      type: accountType as BuzzSpendType,
    });

    const startPct = currentPct;
    currentPct += (pct || 0) * 100;
    return `${typeConfig.color} ${startPct}%, ${typeConfig.color} ${currentPct}%`;
  });

  return `linear-gradient(to ${direction}, ${gradientStops.join(', ')})`;
};

export const getAccountTypeLabel = (accountType: BuzzSpendType): string => {
  return capitalize(accountType);
};

// Create tooltip label for distribution
export const createBuzzDistributionLabel = ({
  typeDistribution,
}: {
  typeDistribution?: BuzzTypeDistribution;
}) => {
  if (!typeDistribution) return undefined;

  const entries = Object.entries(typeDistribution.amt).filter(([, amount]) => (amount || 0) > 0);
  return entries
    .map(([accountType, amount]) => {
      const typeName = getAccountTypeLabel(accountType as BuzzSpendType);
      return `${typeName}: ${(amount || 0).toLocaleString()}`;
    })
    .join(' | ');
};

export const getBuzzWithdrawalDetails = (buzzAmount: number, platformFeeRate?: number) => {
  if (!platformFeeRate) {
    platformFeeRate = buzzConstants.platformFeeRate;
  }
  const dollarAmount = Math.round((buzzAmount / buzzConstants.buzzDollarRatio) * 100);
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
