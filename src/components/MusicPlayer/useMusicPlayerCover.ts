import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { musicAccentFromHash } from '~/components/MusicPlayer/music-accent';
import type { PlayerSongCover } from '~/server/services/post.service';
import { Flags } from '~/shared/utils/flags';
import { trpc } from '~/utils/trpc';

// The most ids `image.getSongCovers` takes in one read.
const MAX_COVER_IDS = 100;
const COVER_STALE_MS = 5 * 60 * 1000;

/**
 * The covers the player may show for `songIds`, by song id. The server returns only clean covers the
 * viewer may see; one shows here only inside the viewer's browsing level, else the song has none
 * (the placeholder and the Civitai primary).
 */
export function useMusicPlayerCovers(songIds: number[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const ids = songIds.slice(0, MAX_COVER_IDS);
  const { data } = trpc.image.getSongCovers.useQuery(
    { ids },
    { staleTime: COVER_STALE_MS, enabled: ids.length > 0 }
  );
  return useMemo(() => {
    const shown = new Map<number, PlayerSongCover>();
    for (const cover of data ?? [])
      if (Flags.intersects(browsingLevel, cover.nsfwLevel)) shown.set(cover.songId, cover);
    return shown;
  }, [data, browsingLevel]);
}

/** The cover the player shows for `songId` and the accent taken from it. */
export function useMusicPlayerCover(songId: number) {
  const cover = useMusicPlayerCovers([songId]).get(songId) ?? null;
  const hash = cover?.hash;
  const accent = useMemo(() => musicAccentFromHash(hash), [hash]);
  return { cover, accent };
}
