import { useCallback } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type PlayerStore = {
  currentTrack: Track | null;
  setCurrentTrack: (arg: Track | null) => void;
  isPlaying: () => boolean;
};

export const usePlayerStore = create<PlayerStore>()(
  immer((set, get) => ({
    currentTrack: null,
    setCurrentTrack: (track) => {
      set((state) => {
        const prevTrack = state.currentTrack;
        if (!prevTrack || prevTrack.media !== track?.media) {
          if (prevTrack) {
            prevTrack.media.pause();
            prevTrack.media.currentTime = 0;
          }
        }
        state.currentTrack = track;
      });
    },
    isPlaying: () => {
      const currentTrack = get().currentTrack;
      return !currentTrack?.media?.paused ?? false;
    },
  }))
);

// export const usePlayerStore = () => {
//   return useStore(useCallback((state) => state, []));
// };
