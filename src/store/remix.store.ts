/**
 * Remix Store
 *
 * Stores the remix source ID and original generation data for similarity checking.
 * When a user remixes an image, we store the original params here so we can
 * calculate how much the current form has deviated from the original.
 *
 * If similarity drops below 75%, the generation is treated as a new image
 * rather than a remix.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface RemixData {
  /** The image ID being remixed */
  remixOfId: number;
  /** Original generation parameters for similarity comparison */
  originalParams: Record<string, unknown>;
  /** Timestamp when remix was initiated */
  createdAt: number;
}

interface RemixState {
  /** Current remix data (if any) */
  data: RemixData | null;

  /** Set remix data when user initiates a remix */
  setRemix: (remixOfId: number, originalParams: Record<string, unknown>) => void;

  /** Clear remix data (e.g., on form reset or new generation) */
  clearRemix: () => void;
}

export const useRemixStore = create<RemixState>()(
  persist(
    (set) => ({
      data: null,

      setRemix: (remixOfId, originalParams) => {
        set({
          data: {
            remixOfId,
            originalParams,
            createdAt: Date.now(),
          },
        });
      },

      clearRemix: () => {
        set({ data: null });
      },
    }),
    {
      name: 'remix-data',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

/** Standalone accessor for use outside React components */
export const remixStore = {
  setRemix: (remixOfId: number, originalParams: Record<string, unknown>) => {
    useRemixStore.getState().setRemix(remixOfId, originalParams);
  },
  clearRemix: () => {
    useRemixStore.getState().clearRemix();
  },
  getData: () => {
    return useRemixStore.getState().data;
  },
};
