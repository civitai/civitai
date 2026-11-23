import { csamHeldImageSql, imageAlias } from './csam-held';

/**
 * A song held for csam review because of its lyrics or its cover, as plain SQL text each app wraps in
 * its own builder: the main app flags the song (`flagImagesForCsamReview`), and both apps release it
 * when the lyrics hold or the cover's review closes as not csam.
 *
 * The song's own "Image" row records which of its parts made this mechanism flag it, under
 * `metadata.csamHold` (`{ lyrics?: <hold id>, cover?: <cover image id>, prior?: <review> }`, `prior`
 * being the other review the flag replaced, which a release puts back). The key exists only while the
 * mechanism owns the flag: a moderator flagging the song itself removes it, and a flag without it is
 * never released here.
 */

export const SONG_CSAM_HOLD_KEY = 'csamHold';

export type SongCsamHoldSource = 'lyrics' | 'cover';

type LyricsHoldStatus = 'Pending' | 'Confirmed';

const INT4_MAX = 2_147_483_647;

/** A csam hold on the lyrics of the song whose "Image" row is aliased `image`, in `statuses`. */
const lyricsHoldSql = (
  image: string,
  statuses: LyricsHoldStatus[]
) => `EXISTS (SELECT 1 FROM "TextScanHold" h
    WHERE h."entityType" = 'TrackLyrics' AND h."entityId" = ${image}.id AND h.label = 'csam'
      AND h.status::text IN (${statuses.map((status) => `'${status}'`).join(', ')}))`;

/**
 * Whether the "Image" row aliased `image` (an alias, or `"Image"` for an unaliased table) is a song
 * whose lyrics hold a moderator confirmed. A confirmed hold keeps the song held as a confirmed video
 * stays removed, so a lift of the song's own flag must not apply to it.
 */
export function confirmedLyricsHoldSql(image: string): string {
  return lyricsHoldSql(imageAlias(image), ['Confirmed']);
}

/** Image ids as an int[] literal; throws on anything but positive int4 values, since it is spliced. */
function idArray(ids: number[]): string {
  for (const id of ids)
    if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) throw new Error('Bad image id');
  return `ARRAY[${[...new Set(ids)].join(', ')}]::int[]`;
}

/**
 * The id of the song the "Image" row aliased `cover` is the cover of, or NULL. It does not check the
 * row it finds is a song: every write it feeds keeps to `audio` rows itself.
 */
export function songIdOfCoverSql(cover: string): string {
  const c = imageAlias(cover);
  return `(SELECT s.id FROM "Image" s
    WHERE s.id = CASE WHEN ${c}."metadata" ->> 'parentId' ~ '^[0-9]{1,9}$' THEN (${c}."metadata" ->> 'parentId')::int END
      AND s."userId" = ${c}."userId" AND ${c}."postId" IS NULL
      AND s."metadata" ->> 'coverImageId' = ${c}.id::text)`;
}

/** The songs a release reaches: the given songs, or the songs of the given covers. */
export type SongCsamReleaseTarget =
  | { source: 'lyrics'; songIds: number[] }
  | { source: 'cover'; coverIds: number[] };

function targetSongsSql(target: SongCsamReleaseTarget): string | null {
  if (target.source === 'lyrics')
    return target.songIds.length ? `SELECT unnest(${idArray(target.songIds)})` : null;
  if (!target.coverIds.length) return null;
  return `SELECT ${songIdOfCoverSql('c')} FROM "Image" c WHERE c.id = ANY(${idArray(
    target.coverIds
  )})`;
}

/**
 * Writes only songs whose flag this mechanism set (the marker) and whose `source` is no longer open.
 * The marker keeps the sources still open; the flag and marker come off, back to the replaced review
 * (`prior`), only when no lyrics hold (Pending or Confirmed), recorded cover hold or open user CSAM
 * report remains.
 */
function releaseSql(songs: string, source: SongCsamHoldSource): string {
  const marker = `s."metadata" -> '${SONG_CSAM_HOLD_KEY}'`;
  const lyricsOpen = lyricsHoldSql('s', ['Pending', 'Confirmed']);
  const coverOpen = `EXISTS (SELECT 1 FROM "Image" hc
    WHERE ${marker} ->> 'cover' ~ '^[0-9]{1,9}$' AND hc.id = (${marker} ->> 'cover')::int AND ${csamHeldImageSql(
    'hc'
  )})`;
  const reportOpen = `EXISTS (SELECT 1 FROM "ImageReport" ir JOIN "Report" r ON r.id = ir."reportId"
    WHERE ir."imageId" = s.id AND r.reason::text = 'CSAM' AND r.status::text IN ('Pending', 'Processing'))`;
  const sourceOpen = source === 'lyrics' ? lyricsOpen : coverOpen;
  const released = `(NOT ${lyricsOpen} AND NOT ${coverOpen} AND NOT ${reportOpen})`;
  const kept = `jsonb_strip_nulls(jsonb_build_object(
    'lyrics', CASE WHEN ${lyricsOpen} THEN ${marker} -> 'lyrics' END,
    'cover', CASE WHEN ${coverOpen} THEN ${marker} -> 'cover' END,
    'prior', ${marker} -> 'prior'))`;
  return `UPDATE "Image" s SET
    "needsReview" = CASE WHEN ${released} THEN ${marker} ->> 'prior' ELSE s."needsReview" END,
    "metadata" = CASE WHEN ${released} THEN s."metadata" - '${SONG_CSAM_HOLD_KEY}'
      ELSE jsonb_set(s."metadata", '{${SONG_CSAM_HOLD_KEY}}', ${kept}) END
  WHERE s.id IN (${songs}) AND s.type = 'audio' AND s."needsReview" = 'csam'
    AND jsonb_typeof(${marker}) = 'object' AND ${marker} ? '${source}'
    AND NOT ${sourceOpen}
  RETURNING s.id, NOT (s."metadata" ? '${SONG_CSAM_HOLD_KEY}') AS released`;
}

/**
 * Re-decides each flagged song a closed lyrics hold or cleared cover review reaches, in the caller's
 * transaction: `run` executes one statement there and returns its rows. Returns the ids it released.
 */
export async function releaseSongCsamHold(
  run: (sql: string) => Promise<{ id: number; released?: boolean }[]>,
  target: SongCsamReleaseTarget
): Promise<number[]> {
  const songs = targetSongsSql(target);
  if (!songs) return [];
  // Its own statement first: the release then reads every source as committed by whoever held the
  // row, rather than as its own statement found them before it waited.
  const locked = await run(
    `SELECT s.id FROM "Image" s WHERE s.id IN (${songs}) ORDER BY s.id FOR UPDATE`
  );
  if (!locked.length) return [];
  const rows = await run(releaseSql(songs, target.source));
  return rows.filter((row) => row.released).map((row) => row.id);
}
