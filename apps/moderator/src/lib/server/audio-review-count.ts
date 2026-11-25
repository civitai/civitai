import { sql } from '@civitai/db/kysely';
import { songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { IMAGE_REVIEW_SLUGS } from '$lib/image-review';
import { ReportStatus, SONG_ENTITY_TYPE } from '$lib/rating-review';
import { DEFAULT_REPORT_REASONS, reportCountKey } from '$lib/reports';
import { dbRead } from './db';

/** Image reports' reasons (`DEFAULT_REPORT_REASONS`), so a report is in exactly one of the two
 *  queues. Kept apart from `audio-review.service.ts` so the sidebar counts import no more than this. */
export const pendingSongReports = () =>
  dbRead
    .selectFrom('Report as r')
    .innerJoin('ImageReport as ir', 'ir.reportId', 'r.id')
    .innerJoin('Image as i', 'i.id', 'ir.imageId')
    .where('r.status', '=', 'Pending')
    .where('r.reason', 'in', DEFAULT_REPORT_REASONS)
    .where('i.type', '=', 'audio');

/** Image reports' badge drops these reports, as its queue does. */
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

/** A song or its own cover: what the Appeals tab decides and the image Appeals queue leaves out, so
 *  an appeal is in exactly one of the two. */
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

export async function countSongAppeals(): Promise<number> {
  const row = await songAppealImages()
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirst();
  return row?.n ?? 0;
}

/** The review flags the Held tab decides on a song or its own cover: the generic review queues'.
 *  The CSAM flag stays with the CSAM queue and an appeal with the Appeals tab. */
export const HELD_REVIEW_FLAGS: readonly string[] = IMAGE_REVIEW_SLUGS;
const heldFlagsSql = HELD_REVIEW_FLAGS.map((f) => `'${f}'`).join(', ');

/** The song aliased `song` has its lyrics under a Pending CSAM text hold (`TrackLyrics`, whose
 *  entity id is the song's Image id). */
export const pendingLyricsHoldText = (song: string) =>
  `EXISTS (SELECT 1 FROM "TextScanHold" lyrics_hold
    WHERE lyrics_hold."entityType" = 'TrackLyrics' AND lyrics_hold."entityId" = ${song}.id
      AND lyrics_hold.label = 'csam' AND lyrics_hold.status = 'Pending')`;

/** Whether the Held tab, not the generic review queues, decides this image's review flag (a flag is
 *  decided in one place). The flagged cover of a lyrics-held song stays in the generic queues: the
 *  Held tab shows that song only as its hold. */
export const onHeldTabText = (image: string) =>
  `((${image}.type = 'audio' AND NOT ${pendingLyricsHoldText(image)}) OR EXISTS (
    SELECT 1 FROM "Track" held_track JOIN "Image" held_song ON held_song.id = held_track."imageId"
    WHERE held_track."coverImageId" = ${image}.id AND ${songsOwnCoverText(image, 'held_song')}
      AND NOT ${pendingLyricsHoldText('held_song')}
  ))`;

/** The songs flagged for review themselves (Held tab, "song" rows): a held flag, Scanned as the
 *  review queues list it, not under a lyrics hold. Null, not false, on a song with no flag, so
 *  negate it through COALESCE; left bare, the flag test is served by `Image_needsReview_index`. */
export const flaggedSongsText = (song: string) =>
  `(${song}.type = 'audio' AND ${song}."needsReview" IN (${heldFlagsSql})
    AND ${song}.ingestion = 'Scanned' AND NOT ${pendingLyricsHoldText(song)})`;

/** The own cover aliased `cover` of the song aliased `song` is flagged for review (Held tab, "cover"
 *  rows), on a song not under a lyrics hold and not flagged itself (that row is the song's). */
export const flaggedCoverText = (cover: string, song: string) =>
  `(${song}.type = 'audio' AND ${songsOwnCoverText(cover, song)}
    AND ${cover}."needsReview" IN (${heldFlagsSql}) AND ${cover}.ingestion = 'Scanned'
    AND NOT ${pendingLyricsHoldText(song)} AND NOT COALESCE(${flaggedSongsText(song)}, false))`;

/** Lyrics holds apart: they are decided in CSAM holds, so not in the sidebar badge. */
export async function countHeldSongs(): Promise<{ lyrics: number; actionable: number }> {
  const { rows } = await sql<{ lyrics: number; actionable: number }>`
    SELECT
      (SELECT count(DISTINCT h."entityId")::int FROM "TextScanHold" h
        JOIN "Image" s ON s.id = h."entityId" AND s.type = 'audio'
        WHERE h."entityType" = 'TrackLyrics' AND h.label = 'csam' AND h.status = 'Pending') AS lyrics,
      (SELECT count(*)::int FROM "Image" s WHERE ${sql.raw(flaggedSongsText('s'))})
      + (SELECT count(*)::int FROM "Track" t JOIN "Image" s ON s.id = t."imageId"
          JOIN "Image" c ON c.id = t."coverImageId" WHERE ${sql.raw(
            flaggedCoverText('c', 's')
          )}) AS actionable
  `.execute(dbRead);
  return { lyrics: rows[0]?.lyrics ?? 0, actionable: rows[0]?.actionable ?? 0 };
}

/** Owners' Pending rating disputes on songs: the Disputes tab, the only place they are decided
 *  (/ratings and tickets leave them out). */
export const pendingSongDisputes = () =>
  dbRead
    .selectFrom('RatingReview as rr')
    .where('rr.entityType', '=', SONG_ENTITY_TYPE)
    .where('rr.status', '=', ReportStatus.Pending);

export async function countSongDisputes(): Promise<number> {
  const row = await pendingSongDisputes()
    .select(sql<number>`count(*)::int`.as('n'))
    .executeTakeFirst();
  return row?.n ?? 0;
}

/** The four tab badges, before any search. */
export async function songTabCounts() {
  const [reported, appeals, held, disputes] = await Promise.all([
    countReportedSongs(),
    countSongAppeals(),
    countHeldSongs(),
    countSongDisputes(),
  ]);
  return { reported: reported.songs, appeals, held: held.lyrics + held.actionable, disputes };
}
