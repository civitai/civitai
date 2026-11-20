import { useSongPlayTracker } from '~/hooks/useSongPlayTracker';
import { useMusicPlayerStore } from '~/store/music-player.store';

/**
 * Counts plays of the global player's songs. Its own component, so the listen progress it reads
 * on every `timeupdate` re-renders nothing else. Tracking runs while the song plays: a song
 * restored paused after a reload starts nothing until it is played.
 */
export function MusicPlayCounter() {
  const playback = useMusicPlayerStore((s) => s.playback);
  const playing = useMusicPlayerStore((s) => s.playing);
  useSongPlayTracker({
    songId: playback?.songId,
    playbackId: playback?.playbackId,
    durationSec: playback?.durationSec,
    listenedSec: playback?.listenedSec ?? 0,
    enabled: playing,
  });
  return null;
}
