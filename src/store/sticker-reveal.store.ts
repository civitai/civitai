import { useEffect } from 'react';
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
  /**
   * Shown for this view only, because the link asked (`?stickers=1`).
   *
   * Separate from `revealed`, and NOT persisted, because a link must not change
   * a setting the viewer chose: following one notification would otherwise turn
   * stickers on across the whole site, for good, from a press that looked like
   * "see my sticker" (Justin, 2026-08-24).
   *
   * While it is set the surface behaves exactly as if the toggle were on,
   * including the count chip, and the chip does nothing when pressed.
   */
  forced: boolean;
  toggle: () => void;
  setRevealed: (revealed: boolean) => void;
  setForced: (forced: boolean) => void;
}

export const useStickerRevealStore = create<StickerRevealStore>()(
  persist(
    (set) => ({
      revealed: false,
      forced: false,
      // Inert while forced. The alternative is a chip that reads "on", turns the
      // underlying flag off, and leaves the stickers exactly where they were —
      // a control that reports having done something it did not do.
      toggle: () => set((state) => (state.forced ? {} : { revealed: !state.revealed })),
      setRevealed: (revealed) => set({ revealed }),
      setForced: (forced) => set({ forced }),
    }),
    {
      name: 'sticker-reveal',
      storage: createJSONStorage(() => localStorage),
      version: 1,
      // 🔴 `forced` is per-view and must never survive the page. Without this it
      // is written to localStorage on the first forced view and every image on
      // the site shows its stickers from then on, with a toggle that does
      // nothing — the exact outcome this design exists to avoid.
      partialize: (state) => ({ revealed: state.revealed }),
    }
  )
);

/**
 * What every surface should ask, rather than reading `revealed` directly: a
 * consumer that reads the stored flag alone renders nothing on a forced view.
 */
export const stickersRevealed = (state: StickerRevealStore) => state.revealed || state.forced;

export const useStickersRevealed = () => useStickerRevealStore(stickersRevealed);

/**
 * Honours `?stickers=1` for as long as the view is mounted — see
 * `STICKER_REVEAL_PARAM`.
 */
export function useStickerRevealParam(present: boolean) {
  useEffect(() => {
    if (!present) return;

    useStickerRevealStore.getState().setForced(true);
    return () => useStickerRevealStore.getState().setForced(false);
  }, [present]);
}
