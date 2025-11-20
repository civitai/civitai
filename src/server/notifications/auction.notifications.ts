import { MY_BIDS } from '~/shared/constants/auction.constants';
import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { asOrdinal } from '~/utils/number-helpers';

export type DetailsWonAuction = {
  name: string | null;
  position: number;
  until: string | null;
};
export type DetailsDroppedOutAuction = {
  name: string | null;
};
export type DetailsFailedRecurringBid = {
  auctionName: string | null;
};
export type DetailsCanceledBid = {
  name: string | null;
  reason: string;
  recurring: boolean;
};

export const auctionNotifications = createNotificationProcessor({
  'won-auction': {
    displayName: 'Won Auction',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as DetailsWonAuction;
      return {
        message: `Congratulations! Your bid on ${
          details.name ?? 'your item'
        } won! It will be featured${!!details.until ? ` until ${details.until}` : ''}${
          !!details.position ? ` in the ${asOrdinal(details.position)} spot` : ''
        } on the site.`,
        url: `/auctions/${MY_BIDS}`,
      };
    },
  },
  'dropped-out-auction': {
    displayName: 'Losing Auction',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as DetailsDroppedOutAuction;
      return {
        message: `Your bid on ${
          details.name ?? 'your item'
        } has fallen out of its winning position. Increase your bid to win!`,
        url: `/auctions/${MY_BIDS}`,
      };
    },
  },
  'failed-recurring-bid-auction': {
    displayName: 'Failed Recurring Bid',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as DetailsFailedRecurringBid;
      return {
        message: `Your recurring bid for ${
          details.auctionName ?? 'an auction'
        } failed. Please try adding more Buzz to your account, or contact us.`,
        url: `/auctions/${MY_BIDS}`,
      };
    },
  },
  'canceled-bid-auction': {
    displayName: 'Canceled Bid',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: (notification) => {
      const details = notification.details as DetailsCanceledBid;
      return {
        message: `Your ${details.recurring ? 'recurring ' : ''}bid for ${
          details.name ?? 'your item'
        } was canceled. Reason: ${details.reason}.`,
        url: `/auctions/${MY_BIDS}`,
      };
    },
  },
});
