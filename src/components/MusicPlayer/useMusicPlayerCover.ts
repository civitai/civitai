import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { musicAccentFromHash } from '~/components/MusicPlayer/music-accent';
import type { PlayerSongCover } from '~/server/services/post.service';
import { Flags } from '~/shared/utils/flags';
import { chunkIds } from '~/utils/array-helpers';
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
  return useMemo(() => shownCovers(data ?? [], browsingLevel), [data, browsingLevel]);
}

function shownCovers(covers: PlayerSongCover[], browsingLevel: number) {
  const shown = new Map<number, PlayerSongCover>();
  for (const cover of covers)
    if (Flags.intersects(browsingLevel, cover.nsfwLevel)) shown.set(cover.songId, cover);
  return shown;
}

/**
 * `useMusicPlayerCovers` for a list of any length (a feed): one read per 100 songs, chunked in
 * arrival order so a page appended to the list leaves the earlier chunks' reads alone.
 */
export function useSongListCovers(songIds: number[]) {
  const browsingLevel = useBrowsingLevelDebounced();
  const chunks = useMemo(
    () => chunkIds(songIds, MAX_COVER_IDS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unstable array; its join is the key
    [songIds.join(',')]
  );
  const queries = trpc.useQueries((t) =>
    chunks.map((ids) =>
      t.image.getSongCovers(
        { ids },
        // The growing last chunk keeps its covers on screen while its longer read loads.
        { staleTime: COVER_STALE_MS, placeholderData: (previous) => previous }
      )
    )
  );
  const covers = queries.flatMap((query) => query.data ?? []);
  return useMemo(
    () => shownCovers(covers, browsingLevel),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queries unstable; their data is the key
    [browsingLevel, ...queries.map((query) => query.data)]
  );
}

/** The cover the player shows for `songId` and the accent taken from it. */
export function useMusicPlayerCover(songId: number) {
  const cover = useMusicPlayerCovers([songId]).get(songId) ?? null;
  const hash = cover?.hash;
  const accent = useMemo(() => musicAccentFromHash(hash), [hash]);
  return { cover, accent };
}
