import { sql } from '@civitai/db/kysely';
import { blockMarkerText, songsOwnCoverText } from '@civitai/db-queries/profile-picture-clear';
import { logAxiomError } from './axiom';
import { dbRead } from './db';
import { holdsCsamReview } from './held-media';
import { restrictedImageIds } from './retracted-media';

/** What a queue card knows of the song it belongs to (docs/features/music.md "Moderating songs"). */
export type SongLinks = {
  /** On a song: its cover, while there is one to remove. */
  songCoverId: number | null;
  /** On a cover: the song it is the cover of. */
  coverOf: { songId: number; title: string | null } | null;
};

/**
 * The song links of these images: a song's cover (`Track.coverImageId`) and a cover's song. Only the
 * song's own cover counts (`songsOwnCoverText`, the public player's rule), so an image that only
 * happens to be named as a cover, in a post or another user's, links nothing. A cover already
 * removed is not offered for removal again; it still links to its song. Ids with no link are absent.
 */
export async function getSongLinks(imageIds: number[]): Promise<Map<number, SongLinks>> {
  const links = new Map<number, SongLinks>();
  if (!imageIds.length) return links;
  const rows = await dbRead
    .selectFrom('Track as t')
    .innerJoin('Image as s', 's.id', 't.imageId')
    .innerJoin('Image as c', 'c.id', 't.coverImageId')
    .select([
      't.imageId as songId',
      'c.id as coverId',
      sql<string | null>`s.metadata->>'title'`.as('title'),
      sql<boolean>`${sql.raw(blockMarkerText('c'))}`.as('coverRemoved'),
    ])
    .where((eb) => eb.or([eb('t.imageId', 'in', imageIds), eb('t.coverImageId', 'in', imageIds)]))
    .where(sql<boolean>`${sql.raw(songsOwnCoverText('c', 's'))}`)
    .execute();
  const wanted = new Set(imageIds);
  for (const { songId, coverId, title, coverRemoved } of rows) {
    if (wanted.has(songId) && !coverRemoved)
      links.set(songId, { songCoverId: coverId, coverOf: null });
    if (wanted.has(coverId))
      links.set(coverId, { songCoverId: null, coverOf: { songId, title: title || null } });
  }
  return links;
}

/** A card with no song link, and a withheld card, whose song links are not shown. */
export const NO_SONG_LINKS: SongLinks = { songCoverId: null, coverOf: null };

/**
 * The song a removal notice names when `imageId` is a song or its own cover, else null: the notice
 * then says "Your song …" or "The cover of your song …" and links to the song, which is the only
 * page a cover has.
 */
export async function songNoticeSubject(
  imageId: number
): Promise<{ kind: 'song' | 'cover'; songId: number; title: string } | null> {
  const row = await dbRead
    .selectFrom('Track as t')
    .innerJoin('Image as s', 's.id', 't.imageId')
    .leftJoin('Image as c', 'c.id', 't.coverImageId')
    .select(['t.imageId as songId', sql<string | null>`s.metadata->>'title'`.as('title')])
    .where((eb) =>
      eb.or([
        eb('t.imageId', '=', imageId),
        eb.and([
          eb('t.coverImageId', '=', imageId),
          sql<boolean>`${sql.raw(songsOwnCoverText('c', 's'))}`,
        ]),
      ])
    )
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: row.songId === imageId ? 'song' : 'cover',
    songId: row.songId,
    title: row.title ?? '',
  };
}

/**
 * `getSongLinks`, without a link to an image withheld from `user`: a link names another image than
 * the card's own, so the card's own check does not cover it. A withheld cover is not offered for
 * removal (the removal would be refused) and a withheld song is not named. A failed read leaves the
 * cards without song links rather than failing the queue.
 */
export async function visibleSongLinks(ids: number[], user?: App.Locals['user']) {
  try {
    const links = await getSongLinks(ids);
    const linked = [...links.values()].flatMap((l) => [
      ...(l.songCoverId != null ? [l.songCoverId] : []),
      ...(l.coverOf ? [l.coverOf.songId] : []),
    ]);
    if (!linked.length) return links;
    const withheld = await restrictedImageIds(linked, { csamReview: holdsCsamReview(user) });
    for (const [id, l] of links)
      links.set(id, {
        songCoverId: l.songCoverId != null && withheld.has(l.songCoverId) ? null : l.songCoverId,
        coverOf: l.coverOf && withheld.has(l.coverOf.songId) ? null : l.coverOf,
      });
    return links;
  } catch (error) {
    logAxiomError(error, { name: 'image-queue-song-links' });
    return new Map<number, SongLinks>();
  }
}
