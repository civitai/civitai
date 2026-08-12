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
  /**
   * Bumped by every state change that ends a replay.
   *
   * A playing replay is a chain of timers, and clearing them cannot be made to
   * happen reliably at the moment the replay is called off: the popover fades
   * out over 150ms before its content unmounts, so a timer landing in that
   * window used to write a step back over the store AFTER it had been cleared —
   * leaving the image clipped with the panel already shut and nothing on screen
   * to explain it. A timer carries the run it belongs to and is a no-op once
   * this has moved on, so correctness does not depend on the ordering.
   */
  runId: number;
  open: (imageId: number) => void;
  close: () => void;
  setStep: (imageId: number, step: number | null) => void;
  /** Starts a replay at its first sticker and returns the run to stamp timers with. */
  beginRun: (imageId: number) => number;
  /** A timer's write. Ignored unless its run is still the current one. */
  advanceRun: (runId: number, imageId: number, step: number | null) => void;
}

export const useStickerHistoryStore = create<StickerHistoryStore>((set, get) => ({
  imageId: null,
  step: null,
  runId: 0,
  open: (imageId) => set((state) => ({ imageId, step: null, runId: state.runId + 1 })),
  close: () => set((state) => ({ imageId: null, step: null, runId: state.runId + 1 })),
  // A manual step ends any replay in progress, which is what the panel's own
  // controls mean by stepping.
  setStep: (imageId, step) => set((state) => ({ imageId, step, runId: state.runId + 1 })),
  beginRun: (imageId) => {
    const runId = get().runId + 1;
    set({ imageId, step: 0, runId });
    return runId;
  },
  advanceRun: (runId, imageId, step) => {
    if (get().runId !== runId) return;
    set({ imageId, step });
  },
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
