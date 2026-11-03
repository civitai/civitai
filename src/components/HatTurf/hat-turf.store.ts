import { create } from 'zustand';

type HatTurfStore = {
  /** Null means the most recently used hat. */
  cosmeticId: number | null;
  pick: (cosmeticId: number) => void;
  showHats: boolean;
  setShowHats: (show: boolean) => void;
};

export const useHatTurfStore = create<HatTurfStore>((set) => ({
  cosmeticId: null,
  pick: (cosmeticId) => set({ cosmeticId }),
  showHats: true,
  setShowHats: (showHats) => set({ showHats }),
}));
