import { MY_BIDS } from '~/components/Auction/AuctionProvider';
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
});
