import { useCallback } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type PlayerStore = {
  currentTrack: Track | null;
  setCurrentTrack: (arg: Track | null) => void;
};

export const usePlayerStore = create<PlayerStore>()(
  immer((set) => ({
    currentTrack: null,
    setCurrentTrack: (track) => {
      set((state) => {
        state.currentTrack = track;
      });
    },
  }))
);
