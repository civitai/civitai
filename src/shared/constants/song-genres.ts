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

/** The genre stored on a song's metadata, when it is one from the list. */
export function readSongGenre(metadata: unknown): SongGenre | undefined {
  const genre = (metadata as { genre?: unknown } | null | undefined)?.genre;
  return (SONG_GENRES as readonly unknown[]).includes(genre) ? (genre as SongGenre) : undefined;
}

/** The image tag a genre is mirrored as (tag names are stored lowercase). */
export const songGenreTagName = (genre: SongGenre) => genre.toLowerCase();

/** `tags` without the genre's own tag: the genre select shows that one. */
export function withoutGenreTag<T extends { name: string }>(
  tags: T[],
  genre: SongGenre | undefined
) {
  if (!genre) return tags;
  const genreTag = songGenreTagName(genre);
  return tags.filter((tag) => tag.name !== genreTag);
}
