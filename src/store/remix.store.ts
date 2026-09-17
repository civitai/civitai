/**
 * Remix Store
 *
 * Holds the source image the user entered the generator through, so the footer
 * can send `remixOfId` at submit time. It is a claim, not proof — verified
 * derivation is `remix-provenance.store` plus the server's own check.
 *
 * Lifetime is the whole point, and it must not outlive the tab — sessionStorage
 * like `remix-provenance.store`, expired against `createdAt`. `remixOfId` is
 * recorded against blocked prompts in `prohibitedRequests`, so it reaches the
 * evidence a moderator reads when ruling on a restriction, and
 * `audit-remix-sources` can pull the source image — someone else's — into a
 * review queue off it. A claim that outlives the remix puts a stranger's image
 * behind prompts that never touched it (ClickUp 868m5acdq). Whether the claim
 * still HOLDS at submit time is a further question, answered by
 * `utils/remix-claim.ts`.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * Long enough to iterate on a remix, short enough that a tab left open
 * overnight does not carry the source into the next day's prompts.
 */
export const REMIX_CLAIM_TTL = 1000 * 60 * 60 * 2;

export interface RemixData {
  /** The image ID being remixed */
  remixOfId: number;
  /** The generation parameters the remix seeded the form with */
  originalParams: Record<string, unknown>;
  /** Timestamp when remix was initiated */
  createdAt: number;
}

interface RemixState {
  data: RemixData | null;
  setRemix: (remixOfId: number, originalParams: Record<string, unknown>) => void;
  clearRemix: () => void;
}

export function isRemixDataFresh(data: RemixData | null): data is RemixData {
  return !!data && Date.now() - data.createdAt < REMIX_CLAIM_TTL;
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
      storage: createJSONStorage(() => sessionStorage),
      version: 2,
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
  /** Null once past `REMIX_CLAIM_TTL`. Use this, not `getState().data`. */
  getData: () => {
    const { data } = useRemixStore.getState();
    return isRemixDataFresh(data) ? data : null;
  },
};
