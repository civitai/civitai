import { create } from 'zustand';

/**
 * The replay: which point in an image's sticker history is being shown.
 *
 * Global rather than owned by the history panel because the two things it drives
 * are in different trees — the panel lists the stickers, and the overlay draws
 * them over the artwork on the other side of the layout. Scoped to one image at
 * a time by construction: opening the panel on a second image ends the first
 * replay, which is what the carousel needs, since stepping through one image's
 * history and then swiping is otherwise a replay left running behind you.
 *
 * Not persisted. A replay is something you are doing right now, not a setting —
 * unlike the reveal toggle beside it, which is sticky on purpose.
 */
interface StickerHistoryStore {
  imageId: number | null;
  /**
   * Index of the last sticker drawn, or `null` for "draw them all".
   *
   * `null` is the state the panel opens in: reading the list should not blank
   * the image, and the replay is a thing you start.
   */
  step: number | null;
  open: (imageId: number) => void;
  close: () => void;
  setStep: (imageId: number, step: number | null) => void;
}

export const useStickerHistoryStore = create<StickerHistoryStore>((set) => ({
  imageId: null,
  step: null,
  open: (imageId) => set({ imageId, step: null }),
  close: () => set({ imageId: null, step: null }),
  setStep: (imageId, step) => set({ imageId, step }),
}));

/**
 * How much of this image's history to draw: `null` for all of it.
 *
 * Every sticker surface calls this, including the feed cards, so it answers for
 * an image that is not the one being replayed rather than making each caller
 * compare ids.
 */
export const useStickerHistoryStep = (imageId: number) =>
  useStickerHistoryStore((state) => (state.imageId === imageId ? state.step : null));
