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
   * How many mounted views are asking for the reveal, because their link said so
   * (`?stickers=1`).
   *
   * Separate from `revealed`, and NOT persisted, because a link must not change
   * a setting the viewer chose: following one notification would otherwise turn
   * stickers on across the whole site, for good, from a press that looked like
   * "see my sticker" (Justin, 2026-08-24).
   *
   * While it is above zero the surface behaves exactly as if the toggle were on,
   * including the count chip, and the chip does nothing when pressed.
   *
   * 🔴 A COUNT, NOT A BOOLEAN, and the difference is a live bug rather than
   * defensiveness. Two `ImageDetail2` instances can be mounted at once — the
   * remix gallery card on the detail page opens a second one as a routed dialog
   * over the first, and routed dialogs navigate through `history.pushState`
   * rather than next/router, so BOTH read `stickers=1` and both claim the
   * override. With a boolean, closing the dialog cleared it while the page
   * underneath was still mounted and still wanted it — and that instance's
   * effect never re-runs, so the image the link was for ends up showing no
   * stickers under a chip reading off, until a full reload.
   *
   * 🔴 Which of the two overrides a new surface wants: this one is for a whole
   * VIEW, and every consumer honours it through `stickersRevealed`. For one
   * SUBTREE — the sticker book's grid, say — use `ImagesProvider`'s
   * `revealStickers` prop instead. Reaching for this one there would reveal
   * stickers on everything else on the page and make the chip inert site-wide
   * for as long as that subtree was mounted.
   */
  forced: number;
  toggle: () => void;
  setRevealed: (revealed: boolean) => void;
  /** Claims the override for one view; the returned count is not for callers. */
  pushForced: () => void;
  /** Releases one view's claim. Never drops below zero. */
  popForced: () => void;
}

export const useStickerRevealStore = create<StickerRevealStore>()(
  persist(
    (set) => ({
      revealed: false,
      forced: 0,
      // Inert while forced. The alternative is a chip that reads "on", turns the
      // underlying flag off, and leaves the stickers exactly where they were —
      // a control that reports having done something it did not do.
      toggle: () => set((state) => (state.forced > 0 ? {} : { revealed: !state.revealed })),
      setRevealed: (revealed) => set({ revealed }),
      pushForced: () => set((state) => ({ forced: state.forced + 1 })),
      // Floored, so a stray release cannot take the override away from a view
      // that still holds one — the failure that would look like the boolean bug
      // coming back.
      popForced: () => set((state) => ({ forced: Math.max(0, state.forced - 1) })),
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
export const stickersRevealed = (state: StickerRevealStore) => state.revealed || state.forced > 0;

/**
 * Honours `?stickers=1` for as long as the view is mounted — see
 * `STICKER_REVEAL_PARAM`.
 */
export function useStickerRevealParam(present: boolean) {
  useEffect(() => {
    if (!present) return;

    useStickerRevealStore.getState().pushForced();
    return () => useStickerRevealStore.getState().popForced();
  }, [present]);
}
