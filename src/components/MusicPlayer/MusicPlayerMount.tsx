import { useEffect } from 'react';
import { useMusicPlayerResume } from '~/hooks/useMusicPlayerResume';
import { MusicPlayCounter } from '~/components/MusicPlayer/MusicPlayCounter';
import { MusicPlayerAudio } from '~/components/MusicPlayer/MusicPlayerAudio';
import { MusicPlayerBar } from '~/components/MusicPlayer/MusicPlayerBar';
import { MusicPlayerMinimized } from '~/components/MusicPlayer/MusicPlayerMinimized';
import { useMusicPlayerStore } from '~/store/music-player.store';

/**
 * The audio element, mounted for as long as the player may play (Safari refuses a `play()` that is
 * not inside the click, so it cannot wait for a song), and the bar or the minimized cover while one
 * shows. The last song comes back paused after a reload. Its plays are counted.
 */
export default function MusicPlayerMount() {
  // Unmounted only when the player is switched off: nothing may keep playing without it.
  useEffect(() => () => useMusicPlayerStore.getState().close(), []);
  useMusicPlayerResume();
  return (
    <>
      <MusicPlayerAudio />
      <MusicPlayCounter />
      <MusicPlayerBar />
      <MusicPlayerMinimized />
    </>
  );
}
