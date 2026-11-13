import { useEffect } from 'react';
import { persistMusicPlayer, resumeMusicPlayer } from '~/store/music-player-resume';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { trpcVanilla } from '~/utils/trpc';

/**
 * Brings the last song back after a reload, paused where it was, and keeps it saved while the
 * player runs. Mount it with the player only, so nothing loads or is saved without the `music` flag.
 */
export function useMusicPlayerResume() {
  useEffect(() => {
    const stop = persistMusicPlayer({
      store: useMusicPlayerStore,
      playhead: useMusicPlayheadStore,
    });
    let cancelled = false;
    resumeMusicPlayer({
      store: useMusicPlayerStore,
      fetchSong: async (id) => {
        const image = await trpcVanilla.image.get.query({ id });
        // Unmounted meanwhile (the flag turned off): neither restore nor drop anything.
        if (cancelled) throw new Error('unmounted');
        return image;
      },
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);
}
