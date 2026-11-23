/**
 * A song held for csam review because of its lyrics or its cover, as plain SQL text each app wraps in
 * its own builder: the main app flags the song (`flagImagesForCsamReview`), and both apps release it
 * when the lyrics hold or the cover's review closes as not csam.
 *
 * The song's own "Image" row records which of its parts made this mechanism flag it, under
 * `metadata.csamHold` (`{ lyrics?: <hold id>, cover?: <cover image id> }`). The key exists only while
 * the mechanism owns the flag: a moderator flagging the song itself removes it, and a flag without it
 * is never released here.
 */

export const SONG_CSAM_HOLD_KEY = 'csamHold';

export type SongCsamHoldSource = 'lyrics' | 'cover';

const INT4_MAX = 2_147_483_647;

function alias(ref: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ref)) throw new Error(`Bad table alias: ${ref}`);
  return ref;
}

/** Image ids as an int[] literal; throws on anything but positive int4 values, since it is spliced. */
function idArray(ids: number[]): string {
  for (const id of ids)
    if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) throw new Error('Bad image id');
  return `ARRAY[${[...new Set(ids)].join(', ')}]::int[]`;
}

/**
 * The id of the song the "Image" row aliased `cover` is the cover of, or NULL. The one place that
 * reads the link between a song and its cover.
 */
export function songIdOfCoverSql(cover: string): string {
  const c = alias(cover);
  return `(SELECT s.id FROM "Image" s
    WHERE s.id = CASE WHEN ${c}."metadata" ->> 'parentId' ~ '^[0-9]{1,9}$' THEN (${c}."metadata" ->> 'parentId')::int END
      AND s.type = 'audio' AND s."userId" = ${c}."userId" AND ${c}."postId" IS NULL
      AND s."metadata" ->> 'coverImageId' = ${c}.id::text)`;
}

/** The songs a release reaches: the given songs, or the songs of the given covers. */
type ReleaseTarget =
  | { source: 'lyrics'; songIds: number[] }
  | { source: 'cover'; coverIds: number[] };

function targetSongsSql(target: ReleaseTarget): string | null {
  if (target.source === 'lyrics')
    return target.songIds.length ? `SELECT unnest(${idArray(target.songIds)})` : null;
  if (!target.coverIds.length) return null;
  return `SELECT ${songIdOfCoverSql('c')} FROM "Image" c WHERE c.id = ANY(${idArray(
    target.coverIds
  )})`;
}

/**
 * Locks the song rows a release reaches. Run it in the release's transaction, as its own statement
 * before `releaseSongCsamHoldSql`: the release then reads every source as committed by whoever held
 * the row, rather than as its own statement found them before it waited. `null` for no ids.
 */
export function lockSongCsamHoldSql(target: ReleaseTarget): string | null {
  const songs = targetSongsSql(target);
  if (!songs) return null;
  return `SELECT s.id FROM "Image" s WHERE s.id IN (${songs}) ORDER BY s.id FOR UPDATE`;
}

/** Removed for CSAM, or flagged and not dismissed from its queue: the main app's `heldImageSql` and
 *  the moderator app's `HELD_IMAGE`, for the row aliased `image`. */
const heldSql = (
  image: string
) => `(${image}."blockedFor" = 'CSAM' OR (${image}."needsReview" = 'csam'
  AND NOT EXISTS (SELECT 1 FROM "CsamQueueSetAside" sa WHERE sa."imageId" = ${image}.id AND sa.outcome = 'Dismissed')))`;

/**
 * Re-decides each flagged song a release reaches, after its lyrics hold or its cover's review closed.
 * Only a song whose flag this mechanism set (the marker) and whose `source` is no longer open is
 * written: the marker keeps only the sources still open, and the flag (with the marker) comes off
 * only when none is left and no other csam reason remains: no lyrics hold Pending or Confirmed, the
 * recorded cover not held, no open user CSAM report on the song. RETURNING `id, released`. `null`
 * for no ids.
 */
export function releaseSongCsamHoldSql(target: ReleaseTarget): string | null {
  const songs = targetSongsSql(target);
  if (!songs) return null;
  const marker = `s."metadata" -> '${SONG_CSAM_HOLD_KEY}'`;
  const lyricsOpen = `EXISTS (SELECT 1 FROM "TextScanHold" h
    WHERE h."entityType" = 'TrackLyrics' AND h."entityId" = s.id AND h.label = 'csam'
      AND h.status::text IN ('Pending', 'Confirmed'))`;
  const coverOpen = `EXISTS (SELECT 1 FROM "Image" hc
    WHERE ${marker} ->> 'cover' ~ '^[0-9]{1,9}$' AND hc.id = (${marker} ->> 'cover')::int AND ${heldSql(
    'hc'
  )})`;
  const reportOpen = `EXISTS (SELECT 1 FROM "ImageReport" ir JOIN "Report" r ON r.id = ir."reportId"
    WHERE ir."imageId" = s.id AND r.reason::text = 'CSAM' AND r.status::text IN ('Pending', 'Processing'))`;
  const sourceOpen = target.source === 'lyrics' ? lyricsOpen : coverOpen;
  const released = `(NOT ${lyricsOpen} AND NOT ${coverOpen} AND NOT ${reportOpen})`;
  const kept = `jsonb_strip_nulls(jsonb_build_object(
    'lyrics', CASE WHEN ${lyricsOpen} THEN ${marker} -> 'lyrics' END,
    'cover', CASE WHEN ${coverOpen} THEN ${marker} -> 'cover' END))`;
  return `UPDATE "Image" s SET
    "needsReview" = CASE WHEN ${released} THEN NULL ELSE s."needsReview" END,
    "metadata" = CASE WHEN ${released} THEN s."metadata" - '${SONG_CSAM_HOLD_KEY}'
      ELSE jsonb_set(s."metadata", '{${SONG_CSAM_HOLD_KEY}}', ${kept}) END
  WHERE s.id IN (${songs}) AND s.type = 'audio' AND s."needsReview" = 'csam'
    AND jsonb_typeof(${marker}) = 'object' AND ${marker} ? '${target.source}'
    AND NOT ${sourceOpen}
  RETURNING s.id, s."needsReview" IS NULL AS released`;
}
