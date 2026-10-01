import { NotificationCategory } from '~/server/common/enums';
import { createNotificationProcessor } from '~/server/notifications/base.notifications';
import { asOrdinal, numberWithCommas } from '~/utils/number-helpers';

// `crucibleName` is null when the text hadn't passed its scan as safe for everyone.
const quotedName = (name?: string | null) => (name ? ` "${name}"` : '');

export const crucibleNotifications = createNotificationProcessor({
  // Sent to crucible creator when crucible finalizes
  'crucible-ended': {
    displayName: 'Crucible Ended',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => {
      const crucible = `Your crucible${quotedName(details.crucibleName)}`;
      const seedNote = details.seedRefunded
        ? ` Your seeded prize pool of ${numberWithCommas(details.seedRefunded)} Buzz was refunded.`
        : '';
      const url = `/crucibles/${details.crucibleId}`;
      if (!details.totalEntries)
        return {
          message: details.disqualifiedEntries
            ? `${crucible} has ended, but none of its entries could place, so no prizes were awarded.${seedNote}`
            : `${crucible} has ended with no entries.${seedNote}`,
          url,
        };
      return {
        message: `${crucible} has ended! ${numberWithCommas(
          details.totalEntries
        )} entries competed for a prize pool of ${numberWithCommas(
          details.prizePool
        )} Buzz.${seedNote}`,
        url,
      };
    },
  },
  // Sent to the entrant when a moderator removes their entry
  'crucible-entry-removed': {
    displayName: 'Crucible Entry Removed',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `A moderator removed your entry from the crucible${quotedName(
        details.crucibleName
      )}.${
        details.refundedAmount
          ? ` Your ${numberWithCommas(details.refundedAmount)} Buzz entry fee was refunded.`
          : ''
      }`,
      url: `/crucibles/${details.crucibleId}`,
    }),
  },
  // Sent to each entrant when a crucible they entered is cancelled
  'crucible-cancelled': {
    displayName: 'Crucible Cancelled',
    category: NotificationCategory.System,
    toggleable: false,
    prepareMessage: ({ details }) => ({
      message: `The crucible${quotedName(details.crucibleName)} you entered was cancelled. ${
        details.refundPending
          ? 'Your entry fee refund is being processed.'
          : 'Any entry fees you paid have been refunded.'
      }`,
      url: `/crucibles/${details.crucibleId}`,
    }),
  },
  // Sent to all participants when crucible finalizes with their position
  'crucible-won': {
    displayName: 'Crucible Prize Won',
    category: NotificationCategory.System,
    toggleable: true,
    prepareMessage: ({ details }) => {
      if (details.position == null) {
        return {
          message: `The crucible${quotedName(
            details.crucibleName
          )} has ended. Your entry didn't get enough votes to place. Thanks for participating!`,
          url: `/crucibles/${details.crucibleId}`,
        };
      }
      // If prizeAmount is 0, user participated but didn't win a prize
      if (!details.prizeAmount || details.prizeAmount === 0) {
        return {
          message: `The crucible${quotedName(
            details.crucibleName
          )} has ended. Your entry finished at position ${
            details.position
          }. Thanks for participating!`,
          url: `/crucibles/${details.crucibleId}`,
        };
      }
      return {
        message: `Congrats! You placed ${asOrdinal(details.position)} in the crucible${quotedName(
          details.crucibleName
        )}! You've won ${numberWithCommas(details.prizeAmount)} Buzz.`,
        url: `/crucibles/${details.crucibleId}`,
      };
    },
  },
  // Sent to crucible creator when someone submits an entry
  'crucible-entry-submitted': {
    displayName: 'New Entry on Your Crucible',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `${details.entrantUsername} has submitted an entry to your crucible${quotedName(
        details.crucibleName
      )}`,
      url: `/crucibles/${details.crucibleId}`,
    }),
  },
});
