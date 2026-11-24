import { sql } from '@civitai/db/kysely';
import { playerSongCoverText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { storedSongDurationSec } from '@civitai/shared';
import { dbRead } from './db';
import type { SongCard, SongLyricLine } from '$lib/music/song-card';

/** `TrackLyrics.lines` as stored, `[{ t, text }]`, keeping only well-formed lines. */
function lyricLines(value: unknown): SongLyricLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) => {
    const { t, text } = (line ?? {}) as { t?: unknown; text?: unknown };
    if (typeof text !== 'string') return [];
    return [{ t: typeof t === 'number' && Number.isFinite(t) ? t : null, text }];
  });
}

/**
 * What a moderator's song card shows for song `imageId`, or null when it is not a song. The cover is
 * shown only as the main app's `getSongCoversForPlayer` would show it to the public player: the
 * owner's own image outside any post, scanned, with no block marker, not held for review and not
 * flagged as showing a minor. Any other cover is the placeholder, so a blocked or pending one never
 * reaches a queue card. Moderators see every browsing level, so that check has no part here.
 */
export async function getSongCard(imageId: number): Promise<SongCard | null> {
  const row = await dbRead
    .selectFrom('Image as s')
    .leftJoin('Track as t', 't.imageId', 's.id')
    .leftJoin('Image as c', 'c.id', 't.coverImageId')
    .leftJoin('TrackLyrics as l', 'l.imageId', 's.id')
    .select([
      's.id',
      's.url',
      sql<string | null>`s.metadata->>'title'`.as('title'),
      sql<unknown>`s.metadata->'duration'`.as('duration'),
      'l.lines',
      'c.id as coverId',
      'c.url as coverUrl',
      sql<boolean>`COALESCE(${sql.raw(songsOwnCoverText('c', 's'))} AND ${sql.raw(
        playerSongCoverText('c')
      )}, false)`.as('coverShown'),
    ])
    .where('s.id', '=', imageId)
    .where('s.type', '=', 'audio')
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    url: row.url,
    title: row.title || null,
    durationSec: storedSongDurationSec(row.duration),
    cover:
      row.coverShown && row.coverId != null && row.coverUrl
        ? { id: row.coverId, url: row.coverUrl }
        : null,
    lines: lyricLines(row.lines),
  };
}
