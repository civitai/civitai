import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { musicAccentFromHash } from '~/components/MusicPlayer/music-accent';
import type { PlayerSongCover } from '~/server/services/post.service';
import {
  MAX_SONG_IDS_PER_READ,
  SONG_LIST_STALE_MS,
  useSongListReads,
} from '~/components/MusicPlayer/useSongListReads';
import { Flags } from '~/shared/utils/flags';
import { trpc } from '~/utils/trpc';

/**
 * The covers the player may show for `songIds`, by song id. The server returns only clean covers the
 * viewer may see; one shows here only inside the viewer's browsing level, else the song has none
 * (the placeholder and the Civitai primary).
 */
export function useMusicPlayerCovers(songIds: number[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const ids = songIds.slice(0, MAX_SONG_IDS_PER_READ);
  const { data } = trpc.image.getSongCovers.useQuery(
    { ids },
    { staleTime: SONG_LIST_STALE_MS, enabled: ids.length > 0 }
  );
  return useMemo(() => shownCovers(data ?? [], browsingLevel), [data, browsingLevel]);
}

function shownCovers(covers: PlayerSongCover[], browsingLevel: number) {
  const shown = new Map<number, PlayerSongCover>();
  for (const cover of covers)
    if (Flags.intersects(browsingLevel, cover.nsfwLevel)) shown.set(cover.songId, cover);
  return shown;
}

/** `useMusicPlayerCovers` for a list of any length (a feed), read in chunks. */
export function useSongListCovers(songIds: number[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const chunks = useSongListReads('getSongCovers', songIds);
  return useMemo(
    () =>
      shownCovers(
        chunks.flatMap((data) => data ?? []),
        browsingLevel
      ),
    [chunks, browsingLevel]
  );
}

/** The cover the player shows for `songId` and the accent taken from it. */
export function useMusicPlayerCover(songId: number) {
  const cover = useMusicPlayerCovers([songId]).get(songId) ?? null;
  const hash = cover?.hash;
  const accent = useMemo(() => musicAccentFromHash(hash), [hash]);
  return { cover, accent };
}
