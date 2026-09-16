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

    // An open-ended announcement (`endsAt: null`) has not ended and is never a candidate.
    const ended = await dbRead.announcement.findMany({
      where: { endsAt: { lt: cutoff } },
      select: { id: true },
    });
    if (!ended.length) return { deleted: 0 };

    let deleted = 0;
    for (const batch of chunk(
      ended.map((x) => x.id),
      DELETE_CHUNK_SIZE
    )) {
      const { count } = await dbWrite.announcementDismissal.deleteMany({
        where: { announcementId: { in: batch } },
      });
      deleted += count;
    }

    log(`deleted ${deleted} dismissals for ${ended.length} announcements ended before ${cutoff}`);

    return { deleted };
  },
  { lockExpiration: 5 * 60 }
);
