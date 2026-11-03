import { create } from 'zustand';

type HatTurfStore = {
  /** The hat the viewer picked in the gear menu; null means their most recently used. */
  cosmeticId: number | null;
  pick: (cosmeticId: number) => void;
  /** Whether hats are drawn on cards at all. The standings badge shows either way. */
  showHats: boolean;
  setShowHats: (show: boolean) => void;
};

export const useHatTurfStore = create<HatTurfStore>((set) => ({
  cosmeticId: null,
  pick: (cosmeticId) => set({ cosmeticId }),
  showHats: true,
  setShowHats: (showHats) => set({ showHats }),
}));
