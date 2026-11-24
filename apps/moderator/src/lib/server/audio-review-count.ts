import { sql } from '@civitai/db/kysely';
import { songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { DEFAULT_REPORT_REASONS, reportCountKey } from '$lib/reports';
import { dbRead } from './db';

/**
 * Pending reports on songs (`Image` type audio), the Reported tab of Audio review. The reasons are
 * the ones Image reports counts (`DEFAULT_REPORT_REASONS`), so a report is in exactly one of the two
 * queues. Kept apart from `audio-review.service.ts` so the sidebar counts import no more than this.
 */
export const pendingSongReports = () =>
  dbRead
    .selectFrom('Report as r')
    .innerJoin('ImageReport as ir', 'ir.reportId', 'r.id')
    .innerJoin('Image as i', 'i.id', 'ir.imageId')
    .where('r.status', '=', 'Pending')
    .where('r.reason', 'in', DEFAULT_REPORT_REASONS)
    .where('i.type', '=', 'audio');

/** The sidebar badge: songs with a Pending report, and those reports (Image reports' badge drops
 *  them, as its queue does). */
export async function countReportedSongs(): Promise<{ songs: number; reports: number }> {
  const row = await pendingSongReports()
    .select([
      sql<number>`count(DISTINCT i.id)::int`.as('songs'),
      sql<number>`count(*)::int`.as('reports'),
    ])
    .executeTakeFirst();
  return { songs: row?.songs ?? 0, reports: row?.reports ?? 0 };
}

/** The report badges with songs moved out of Image Reports into Audio review. Unknown song counts
 *  (`null`, a timed-out read) leave Image Reports counting them and give Audio review no badge. */
export function withSongBadges(
  reports: Record<string, number>,
  songs: { songs: number; reports: number } | null
): Record<string, number> {
  if (!songs) return reports;
  const image = reportCountKey('image');
  return { ...reports, [image]: (reports[image] ?? 0) - songs.reports, audioReview: songs.songs };
}

/**
 * Whether the `Image` aliased `image` is a song or a song's own cover (`songsOwnCoverText`, the public
 * player's rule): what Audio review's Appeals tab decides, and what the image Appeals queue leaves
 * out, so an appeal is in exactly one of the two.
 */
export const songOrOwnCoverText = (image: string) =>
  `(${image}.type::text = 'audio' OR EXISTS (
    SELECT 1 FROM "Track" song_track JOIN "Image" song_image ON song_image.id = song_track."imageId"
    WHERE song_track."coverImageId" = ${image}.id AND ${songsOwnCoverText(image, 'song_image')}
  ))`;

/** The image appeals Audio review lists: on a song or its own cover, flagged for appeal, with a
 *  Pending appeal that `resolveImageAppeal` closes (one not on a removed-before-review entity). */
export const songAppealImages = () =>
  dbRead
    .selectFrom('Image as i')
    .where('i.needsReview', '=', 'appeal')
    .where(sql<boolean>`${sql.raw(songOrOwnCoverText('i'))}`)
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom('Appeal as pa')
          .select('pa.id')
          .where('pa.entityType', '=', 'Image')
          .whereRef('pa.entityId', '=', 'i.id')
          .where('pa.status', '=', 'Pending')
          .where('pa.entityRemovedAt', 'is', null)
      )
    );

/** The Appeals tab's badge: songs and covers with a Pending appeal. */
export async function countSongAppeals(): Promise<number> {
  const row = await songAppealImages()
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirst();
  return row?.n ?? 0;
}
