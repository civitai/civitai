import { CurrencyConfig } from '~/server/common/constants';
import { NsfwLevel } from '~/server/common/enums';
import type {
  BuzzAccountType,
  BuzzSpendType,
  BuzzTransactionDetails,
} from '~/server/schema/buzz.schema';
import { Currency } from '~/shared/utils/prisma/enums';
import { capitalize } from '~/utils/string-helpers';

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
  const baseNotification = `You received a tip of ${details.amount} Buzz from ${
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

/**
 * Gets the supported Buzz account types for a transaction based on NSFW level and content rating.
 * Returns 'user' and either 'green' for safe content or 'fakered' for NSFW content.
 *
 * @param data - Configuration object
 * @param data.nsfwLevel - The NSFW level enum value (optional)
 * @param data.isNsfw - Boolean flag indicating if content is NSFW (optional)
 * @returns Array of supported BuzzAccountType values for the transaction
 */
export const getBuzzTransactionSupportedAccountTypes = ({
  nsfwLevel,
  isNsfw,
}: {
  nsfwLevel?: NsfwLevel;
  isNsfw?: boolean;
}): BuzzAccountType[] => {
  const accountTypes: BuzzAccountType[] = [];
  if ((typeof isNsfw !== 'undefined' && !isNsfw) || (nsfwLevel ?? 0) <= NsfwLevel.R) {
    accountTypes.push('green');
  }

  accountTypes.push('user');

  if ((nsfwLevel ?? 0) > NsfwLevel.R || isNsfw) {
    accountTypes.push('fakered');
    // accountTypes.push('red');
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
  if (entries.length <= 1) return undefined;

  let currentPct = 0;
  const gradientStops = entries.map(([accountType, pct]) => {
    const typeConfig =
      CurrencyConfig[Currency.BUZZ].themes?.[accountType as BuzzSpendType] ??
      CurrencyConfig[Currency.BUZZ];
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
