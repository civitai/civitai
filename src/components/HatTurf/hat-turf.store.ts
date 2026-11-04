import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type HatTurfStore = {
  /** Null means the most recently used hat. */
  cosmeticId: number | null;
  pick: (cosmeticId: number) => void;
  showHats: boolean;
  setShowHats: (show: boolean) => void;
};

export const useHatTurfStore = create<HatTurfStore>()(
  persist(
    (set) => ({
      cosmeticId: null,
      pick: (cosmeticId) => set({ cosmeticId }),
      showHats: true,
      setShowHats: (showHats) => set({ showHats }),
    }),
    {
      name: 'hat-turf',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      partialize: ({ showHats }) => ({ showHats }),
    }
  )
);
