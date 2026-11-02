import type { Prisma } from '@prisma/client';

/**
 * Enabled announcements whose (open-ended) start/end window overlaps `[from, to]`.
 *
 * The single source of truth for "is this announcement showing". `activeAnnouncementWhere`
 * is the degenerate `from === to === now` case used by the read path; the media health
 * check widens only the upper bound so it can see a banner before it goes live.
 */
export function announcementWindowOverlapsWhere(
  from: Date,
  to: Date
): Prisma.AnnouncementWhereInput {
  return {
    disabled: false,
    AND: [
      {
        OR: [{ startsAt: { lte: to } }, { startsAt: { equals: null } }],
      },
      {
        OR: [{ endsAt: { gte: from } }, { endsAt: { equals: null } }],
      },
    ],
  };
}

/**
 * The "currently live" predicate: enabled, and now is inside the (open-ended)
 * start/end window. Shared with the announcement media health check so a monitor
 * can never disagree with the read path about which announcements are live.
 */
export function activeAnnouncementWhere(now: Date): Prisma.AnnouncementWhereInput {
  return announcementWindowOverlapsWhere(now, now);
}
