import { useEffect } from 'react';
import { MusicPlayerAudio } from '~/components/MusicPlayer/MusicPlayerAudio';
import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { useMusicPlayerStore } from '~/store/music-player.store';

/**
 * The audio element, mounted for as long as the player may play (Safari refuses a `play()` that is
 * not inside the click, so it cannot wait for a song), and the bar while it shows.
 */
export default function MusicPlayerMount() {
  // Unmounted only when the player is switched off: nothing may keep playing without it.
  useEffect(() => () => useMusicPlayerStore.getState().close(), []);
  return (
    <>
      <MusicPlayerAudio />
      <MusicPlayerBar />
    </>
  );
}
