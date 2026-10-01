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
    prepareMessage: ({ details }) => ({
      message: `Your crucible${quotedName(details.crucibleName)} has ended! ${
        details.totalEntries
      } entries competed for a prize pool of ${numberWithCommas(details.prizePool)} Buzz.`,
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
