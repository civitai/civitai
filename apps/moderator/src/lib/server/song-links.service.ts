import { sql } from '@civitai/db/kysely';
import {
  blockMarkerText,
  songNoticeSubject as sharedSongNoticeSubject,
  songsOwnCoverText,
} from '@civitai/db-queries/profile-picture-clear';
import { logAxiomError } from './axiom';
import { dbRead } from './db';
import { holdsCsamReview } from './held-media';
import { restrictedImageIds } from './retracted-media';

export type SongLinks = {
  /** On a song: its cover, while there is one to remove. */
  songCoverId: number | null;
  /** On a cover: the song it is the cover of. */
  coverOf: { songId: number; title: string | null } | null;
};

/** Only the song's own cover links (`songsOwnCoverText`): an image merely named as a cover, in a post
 *  or another user's, links nothing. A removed cover still links to its song. */
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

export const NO_SONG_LINKS: SongLinks = { songCoverId: null, coverOf: null };

/** The shared `songNoticeSubject`, on this app's replica. */
export const songNoticeSubject = (imageId: number) => sharedSongNoticeSubject(dbRead, imageId);

/** `getSongLinks` without a link to an image withheld from `user` (the card's own check does not
 *  cover the image a link names). A failed read leaves the cards without links rather than failing
 *  the queue. */
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
