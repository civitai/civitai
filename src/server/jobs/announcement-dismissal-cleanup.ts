import { chunk } from 'lodash-es';
import { dbRead, dbWrite } from '~/server/db/client';
import { createLogger } from '~/utils/logging';
import { createJob } from './job';

const log = createLogger('announcement-dismissal-cleanup', 'blue');

/**
 * 🔴 Load-bearing, and the reason this job is not simply "delete what the read no longer returns".
 *
 * Moderators retire an announcement by disabling it and edit it back months later (announcement
 * 754: created 2026-07-31, updated 2026-09-15). Deleting a dismissal the moment its announcement
 * stops showing means a re-enable resurfaces it for everyone who already dismissed it — the
 * client-side prune defect, moved to the server. An expired row costs a row; an eager delete
 * costs the feature.
 */
const RETENTION_DAYS = 90;

// The announcementId index serves this, and a chunk keeps each statement's parameter list and
// lock footprint small.
const DELETE_CHUNK_SIZE = 500;

export const announcementDismissalCleanupJob = createJob(
  'announcement-dismissal-cleanup',
  '15 5 * * *',
  async () => {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Two ways an announcement stops being shown, and most retired ones use the second: a large
    // minority of prod rows carry no `endsAt` at all, so an `endsAt`-only rule would never
    // collect them. A disabled row is dated by `updatedAt`, so the grace period restarts
    // whenever a moderator touches it — which is the case the period exists for.
    //
    // An open-ended, still-enabled announcement is live and is never a candidate either way.
    const retired = await dbRead.announcement.findMany({
      where: {
        OR: [{ endsAt: { lt: cutoff } }, { disabled: true, updatedAt: { lt: cutoff } }],
      },
      select: { id: true },
    });
    if (!retired.length) return { deleted: 0 };

    let deleted = 0;
    for (const batch of chunk(
      retired.map((x) => x.id),
      DELETE_CHUNK_SIZE
    )) {
      const { count } = await dbWrite.announcementDismissal.deleteMany({
        where: { announcementId: { in: batch } },
      });
      deleted += count;
    }

    log(
      `deleted ${deleted} dismissals for ${retired.length} announcements retired before ${cutoff}`
    );

    return { deleted };
  },
  { lockExpiration: 5 * 60 }
);
