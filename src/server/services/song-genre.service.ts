import { dbRead } from '~/server/db/client';
import { tagCacheByName } from '~/server/redis/caches';
import type { SongGenre } from '~/shared/constants/song-genres';
import { SONG_GENRES, songGenreTagName } from '~/shared/constants/song-genres';

/** The tag id each genre is mirrored as; a genre no song has been published under yet is absent. */
export type SongGenreTagIds = Partial<Record<SongGenre, number>>;

export async function getSongGenreTagIds({
  features,
}: {
  features: { music?: boolean };
}): Promise<SongGenreTagIds> {
  if (!features.music) return {};
  const { found, missing } = await tagCacheByName.fetch(SONG_GENRES.map(songGenreTagName));
  if (missing.length) {
    const tags = await dbRead.tag.findMany({
      where: { name: { in: missing } },
      select: { id: true, name: true, type: true, nsfwLevel: true },
    });
    for (const tag of tags) found.set(tag.name, tag);
    await tagCacheByName.setMany(tags.map((data) => ({ key: data.name, data })));
  }
  return Object.fromEntries(
    SONG_GENRES.flatMap((genre) => {
      const tag = found.get(songGenreTagName(genre));
      return tag ? [[genre, tag.id]] : [];
    })
  );
}
