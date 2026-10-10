import { NotificationCategory } from '~/server/common/enums';
import {
  createNotificationProcessor,
  notBlockedBetween,
} from '~/server/notifications/base.notifications';
import { asOrdinal, numberWithCommas } from '~/utils/number-helpers';
import { getPrizeClaimUrl } from '~/utils/prize-helpers';

// `crucibleName` is null when the text hadn't passed its scan as safe for everyone.
const quotedName = (name?: string | null) => (name ? ` "${name}"` : '');

const CRUCIBLE_ENDING_SOON_HOURS = 8;

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
      // No prize id on a notification sent before prizes were claimable: those were paid outright.
      const claimUrl = getPrizeClaimUrl(details);
      const claim = claimUrl ? ' Claim your prize!' : '';
      // Not the position: a creator holds one prize, so 4th place can take 2nd prize.
      if (details.prizePlace != null)
        return {
          message: `Congrats! You took ${asOrdinal(
            details.prizePlace
          )} prize in the crucible${quotedName(details.crucibleName)} and won ${numberWithCommas(
            details.prizeAmount
          )} Buzz.${claim}`,
          url: claimUrl ?? `/crucibles/${details.crucibleId}`,
        };
      // Sent before prize places existed.
      return {
        message: `Congrats! You placed ${asOrdinal(details.position)} in the crucible${quotedName(
          details.crucibleName
        )}! You've won ${numberWithCommas(details.prizeAmount)} Buzz.${claim}`,
        url: claimUrl ?? `/crucibles/${details.crucibleId}`,
      };
    },
  },
  // Sent once to followers and entrants as a crucible enters its final hours
  'crucible-ending-soon': {
    displayName: 'Crucible you follow or entered is ending soon',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `The crucible${quotedName(
        details.crucibleName
      )} ends in ${CRUCIBLE_ENDING_SOON_HOURS} hours. Last chance to enter or vote!`,
      url: `/crucibles/${details.crucibleId}`,
    }),
    prepareQuery: ({ lastSent }) => `
      WITH affected AS (
        SELECT
          c.id,
          c."userId" "hostId",
          -- getCruciblePublishableName, which a processor query cannot call.
          CASE WHEN c.ingestion = 'Scanned' AND NOT c."textNsfw" THEN c.name END "crucibleName",
          -- isCrucibleHiddenByScan: until both scans pass, only the host can open the crucible.
          (c.ingestion = 'Scanned' AND i.ingestion = 'Scanned') "visible"
        FROM "Crucible" c
        LEFT JOIN "Image" i ON i.id = c."imageId"
        WHERE
          c.status = 'Active'
          AND c."endAt" BETWEEN now() AND now() + interval '${CRUCIBLE_ENDING_SOON_HOURS} hours'
          -- The last scan was before the window opened, so this fires once, on the crossing.
          AND c."endAt" > '${lastSent}'::timestamptz + interval '${CRUCIBLE_ENDING_SOON_HOURS} hours'
          -- A crucible no longer than the window is inside it from the moment it opens.
          AND COALESCE(c."startAt", c."createdAt") < c."endAt" - interval '${CRUCIBLE_ENDING_SOON_HOURS} hours'
      ), target_users AS (
        SELECT DISTINCT "crucibleId", "userId" FROM (
          SELECT a.id "crucibleId", ce."userId"
          FROM affected a
          JOIN "CrucibleEngagement" ce ON ce."crucibleId" = a.id AND ce.type = 'Notify'
          UNION ALL
          SELECT a.id "crucibleId", e."userId"
          FROM affected a
          JOIN "CrucibleEntry" e ON e."crucibleId" = a.id
        ) u
      )
      SELECT
        CONCAT('crucible-ending-soon:', a.id) "key",
        tu."userId" "userId",
        'crucible-ending-soon' "type",
        JSONB_BUILD_OBJECT('crucibleId', a.id, 'crucibleName', a."crucibleName") "details"
      FROM affected a
      JOIN target_users tu ON tu."crucibleId" = a.id
      WHERE (a."visible" OR tu."userId" = a."hostId")
        AND ${notBlockedBetween('tu."userId"', 'a."hostId"')}
        AND NOT EXISTS (SELECT 1 FROM "UserNotificationSettings" WHERE "userId" = tu."userId" AND type = 'crucible-ending-soon')
    `,
  },
  // Sent to followers who are neither the host nor a placed entrant when a crucible finalizes
  'crucible-results': {
    displayName: 'Results for a crucible you follow',
    category: NotificationCategory.Update,
    toggleable: true,
    prepareMessage: ({ details }) => ({
      message: `The crucible${quotedName(details.crucibleName)} has ended. See the results!`,
      url: `/crucibles/${details.crucibleId}`,
    }),
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
