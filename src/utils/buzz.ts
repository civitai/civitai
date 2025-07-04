import { NsfwLevel } from '~/server/common/enums';
import type { BuzzAccountType, BuzzTransactionDetails } from '~/server/schema/buzz.schema';
import { GetUserBuzzTransactionsResponse } from '~/server/schema/buzz.schema';

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
  const accountTypes: BuzzAccountType[] = ['user'];

  if ((nsfwLevel ?? 0) > NsfwLevel.R || isNsfw) {
    accountTypes.push('fakered');
    // accountTypes.push('red');
  } else {
    accountTypes.push('green');
  }

  return accountTypes;
};
