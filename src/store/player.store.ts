import { useCallback } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export type Player = {
  media: HTMLMediaElement;
  peaks: number[][];
};

type PlayerStore = {
  currentTrack: Player | null;
  setCurrentTrack: (track: Player) => void;
  play: () => void;
  pause: () => void;
  isPlaying: boolean;
};

const useStore = create<PlayerStore>()(
  immer((set) => ({
    currentTrack: null,
    setCurrentTrack: (track) => set({ currentTrack: track }),
    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),
    isPlaying: false,
  }))
);

export const usePlayerStore = () => {
  return useStore(useCallback((state) => state, []));
};
