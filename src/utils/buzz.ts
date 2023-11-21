import {
  BuzzTransactionDetails,
  GetUserBuzzTransactionsResponse,
} from '~/server/schema/buzz.schema';

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
