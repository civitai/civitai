import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Whether placed stickers are shown, site-wide and sticky.
 *
 * One flag for the whole session rather than per image: once you turn stickers
 * on you keep seeing them as you move through a feed and open details, until you
 * turn them off. Justin was explicit about this, and it is the reason this is a
 * store rather than component state — per-image state would reset on every
 * navigation and read as the toggle not working.
 *
 * Default off. A creator's work is the thing on the page; the overlay is opt-in.
 */
interface StickerRevealStore {
  revealed: boolean;
  toggle: () => void;
  setRevealed: (revealed: boolean) => void;
}

export const useStickerRevealStore = create<StickerRevealStore>()(
  persist(
    (set) => ({
      revealed: false,
      toggle: () => set((state) => ({ revealed: !state.revealed })),
      setRevealed: (revealed) => set({ revealed }),
    }),
    {
      name: 'sticker-reveal',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export const useStickersRevealed = () => useStickerRevealStore((state) => state.revealed);
