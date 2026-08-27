import { create } from 'zustand';

/**
 * Which galleries the poster has ticked, per image, while they are still editing
 * the post.
 *
 * Client-only and deliberately so: nothing is owed to anyone until Publish, and a
 * tick is not a submission. Writing it server-side would create a half-promise
 * with no event to resolve it — the poster can still delete the image, remove it
 * from the post, or never publish at all.
 *
 * Keyed by image AND host because one image can point at several galleries. The
 * data says that is rare — every remix in a 24h prod sample had exactly one
 * source — but the key is the shape of the thing, not the shape of today's data.
 */

/**
 * What the poster was shown when they ticked it, carried rather than re-read.
 *
 * `submitToRemixGallery` refuses when `expectedPrice` disagrees with the current
 * one, which is what stops an owner raising their price between the tick and the
 * publish and charging without consent. Re-reading the price at submit would
 * defeat that guard by always agreeing with itself.
 */
export type RemixSubmitChoice = {
  hostImageId: number;
  /** `null` on the free path, which has no price to agree to. */
  expectedPrice: number | null;
  free: boolean;
};

type State = {
  /** `imageId -> choices`. Absent means nothing ticked for that image. */
  selected: Record<number, RemixSubmitChoice[]>;
  toggle: (imageId: number, choice: RemixSubmitChoice, on: boolean) => void;
  /**
   * Dropped once its submissions have been made, so a second publish of the same
   * post cannot resubmit them. The mutation refuses a duplicate anyway; this
   * stops the UI from asking for one and reporting a failure the poster caused
   * by pressing a button we left armed.
   */
  clear: (imageId: number) => void;
  clearAll: () => void;
};

export const useRemixSubmitSelection = create<State>((set) => ({
  selected: {},
  toggle: (imageId, choice, on) =>
    set((state) => {
      const current = state.selected[imageId] ?? [];
      const without = current.filter((item) => item.hostImageId !== choice.hostImageId);
      // Replaces rather than skips when already present: a re-tick after the
      // card refetched must carry the price now on screen, not the one from the
      // first tick.
      const next = on ? [...without, choice] : without;

      if (!next.length) {
        const { [imageId]: _dropped, ...rest } = state.selected;
        return { selected: rest };
      }
      return { selected: { ...state.selected, [imageId]: next } };
    }),
  clear: (imageId) =>
    set((state) => {
      const { [imageId]: _dropped, ...rest } = state.selected;
      return { selected: rest };
    }),
  clearAll: () => set({ selected: {} }),
}));

/** Flattened for the publish handler, which submits per (image, host) pair. */
export function pendingRemixSubmissions(selected: Record<number, RemixSubmitChoice[]>) {
  return Object.entries(selected).flatMap(([imageId, choices]) =>
    choices.map((choice) => ({ imageId: Number(imageId), ...choice }))
  );
}
