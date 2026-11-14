import { createContext, useContext, useMemo, useState } from 'react';
import { useMoreFromCreator } from '~/components/Music/SongDetail/useMoreFromCreator';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import type { SongImage } from '~/components/MusicPlayer/PostSong';
import { songTrack } from '~/components/MusicPlayer/PostSong';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';

type SongComments = {
  songId: number;
  /** The song's stored length, the bound the server checks a time against; 0 when it has none. */
  durationSec: number;
  /** Plays the song from `sec`: a seek when it is the current song, otherwise a start there. */
  playFrom: (sec: number) => void;
};

const SongCommentsCtx = createContext<SongComments | null>(null);

/** The song a comment section is on, when it is one; null on any other section. */
export const useSongComments = () => useContext(SongCommentsCtx);

/** Makes a comment section a song's: its comments can carry a time in the song (T7). */
export function SongCommentsProvider({
  song,
  children,
}: {
  song: SongImage;
  children: React.ReactNode;
}) {
  // Not fetched here: when the detail view has loaded the creator's songs, they become Up next,
  // as when the song is played from the view itself.
  const moreFrom = useMoreFromCreator(song, { enabled: false });
  const value = useMemo<SongComments>(
    () => ({
      songId: song.id,
      durationSec: songTrack(song).durationSec,
      playFrom: (sec) => {
        const player = useMusicPlayerStore.getState();
        if (player.current?.id === song.id) {
          seekMusicPlayer(sec);
          if (!player.playing) player.resume();
          return;
        }
        player.playFromList({
          name: song.user.username || moreFrom.name,
          tracks: [song, ...moreFrom.songs].map(songTrack),
          index: 0,
          startAtSec: sec,
        });
      },
    }),
    [song, moreFrom.name, moreFrom.songs]
  );
  return <SongCommentsCtx.Provider value={value}>{children}</SongCommentsCtx.Provider>;
}

/**
 * Whether a new top-level comment on the song takes the playhead's time. On by default; it applies
 * only while the song is the player's current song and has a stored length, and the time is read
 * when the comment is sent, never past that length: the server refuses a time it cannot check.
 */
export function useSongTimeChoice(song: Pick<SongComments, 'songId' | 'durationSec'> | null) {
  const [wanted, setWanted] = useState(true);
  const durationSec = song?.durationSec ?? 0;
  const available = useMusicPlayerStore(
    (s) => !!song && durationSec > 0 && s.current?.id === song.songId
  );
  return {
    available,
    on: available && wanted,
    toggle: () => setWanted((w) => !w),
    /** The whole second to send, or undefined for a comment without a time. */
    timestampSec: () => {
      if (!available || !wanted) return undefined;
      const { currentTime } = useMusicPlayheadStore.getState();
      return Math.max(0, Math.floor(Math.min(currentTime, durationSec)));
    },
  };
}

export type SongTimeChoice = ReturnType<typeof useSongTimeChoice>;
