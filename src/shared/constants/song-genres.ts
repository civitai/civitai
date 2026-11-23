/** The genres a song can be published under. T8's genre chips read the same list. */
export const SONG_GENRES = [
  'Pop',
  'Rock',
  'Hip-Hop',
  'R&B',
  'Electronic',
  'Dance',
  'House',
  'Techno',
  'Synthwave',
  'Lo-fi',
  'Ambient',
  'Jazz',
  'Blues',
  'Classical',
  'Country',
  'Folk',
  'Metal',
  'Punk',
  'Reggae',
  'Latin',
  'K-Pop',
  'Soundtrack',
  'Other',
] as const;
export type SongGenre = (typeof SONG_GENRES)[number];

/** Tags a song can carry besides its genre. */
export const SONG_TAG_LIMIT = 5;
export const SONG_TAG_MAX_LENGTH = 30;

export const SONG_GENRE_REQUIRED_MESSAGE = 'Pick a genre to publish';
export const SONG_GENRE_REQUIRED_PUBLISH_REASON = 'Pick a genre for every song to publish';
export const SONG_TAG_LIMIT_MESSAGE = `A song can have up to ${SONG_TAG_LIMIT} tags besides its genre.`;
export const SONG_TAG_UNAVAILABLE_MESSAGE = "This tag can't be added to a song.";
export const SONG_TAG_NOT_REMOVABLE_MESSAGE = "This tag can't be removed.";

/** A stored genre (`Track.genre`), when it is one from the list. */
export function toSongGenre(value: unknown): SongGenre | undefined {
  return (SONG_GENRES as readonly unknown[]).includes(value) ? (value as SongGenre) : undefined;
}

/** The image tag a genre is mirrored as (tag names are stored lowercase). */
export const songGenreTagName = (genre: SongGenre) => genre.toLowerCase();

/**
 * Every genre's mirror tag name. An owner's tag edits and tag votes refuse these on a song: the
 * genre select is the owner's one way to attach one.
 */
export const SONG_GENRE_TAG_NAMES: readonly string[] = SONG_GENRES.map(songGenreTagName);
export const isSongGenreTagName = (name: string) =>
  SONG_GENRE_TAG_NAMES.includes(name.toLowerCase());

/**
 * SQL condition, built with the caller's `sql` tag (`Prisma.sql`): the vote of `tagId` on
 * `imageId` is not on a song's genre tag. Votes neither record nor attach one.
 */
export function notSongGenreTagVote<S>(
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => S,
  imageId: S,
  tagId: S
) {
  return sql`NOT EXISTS (
    SELECT 1 FROM "Image" song JOIN "Tag" genre_tag ON genre_tag.id = ${tagId}
    WHERE song.id = ${imageId} AND song.type = 'audio'
      AND genre_tag.name = ANY(${SONG_GENRE_TAG_NAMES}::text[])
  )`;
}

/**
 * A feed song's genre, from its tag ids and each genre's mirror tag id (`image.getSongGenreTags`):
 * the first genre in list order whose tag the song carries.
 */
export function songGenreFromTagIds(
  tagIds: readonly number[] | null | undefined,
  genreTagIds: Partial<Record<SongGenre, number>> | undefined
): SongGenre | undefined {
  if (!tagIds?.length || !genreTagIds) return undefined;
  return SONG_GENRES.find((genre) => {
    const tagId = genreTagIds[genre];
    return tagId !== undefined && tagIds.includes(tagId);
  });
}

/** `tags` without the genre's own tag: the genre select shows that one. */
export function withoutGenreTag<T extends { name: string }>(
  tags: T[],
  genre: SongGenre | undefined
) {
  if (!genre) return tags;
  const genreTag = songGenreTagName(genre);
  return tags.filter((tag) => tag.name !== genreTag);
}
