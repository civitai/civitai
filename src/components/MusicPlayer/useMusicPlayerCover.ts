import { useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { musicAccentFromHash } from '~/components/MusicPlayer/music-accent';
import { Flags } from '~/shared/utils/flags';
import { trpc } from '~/utils/trpc';

/**
 * The cover the player shows for `songId` and the accent taken from it. The server returns only a
 * clean cover the viewer may see; it shows here only inside the viewer's browsing level, else the
 * placeholder and the Civitai primary.
 */
export function useMusicPlayerCover(songId: number) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data } = trpc.image.getSongCovers.useQuery(
    { ids: [songId] },
    { staleTime: 5 * 60 * 1000 }
  );
  const found = data?.find((cover) => cover.songId === songId) ?? null;
  const cover = found && Flags.intersects(browsingLevel, found.nsfwLevel) ? found : null;
  const hash = cover?.hash;
  const accent = useMemo(() => musicAccentFromHash(hash), [hash]);
  return { cover, accent };
}
