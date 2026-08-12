import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * How much the viewer stretches or shortens the reveal.
 *
 * A multiplier rather than a duration. The length itself comes from how old the
 * history is — a build spread over a year runs longer than an afternoon's — and
 * a viewer choosing an absolute number overrode exactly the thing that made the
 * reveal say anything. This scales that answer instead of replacing it.
 */
export const REVEAL_MULTIPLIERS = [0.5, 1, 2, 4] as const;

export type RevealMultiplier = (typeof REVEAL_MULTIPLIERS)[number];

export const DEFAULT_REVEAL_MULTIPLIER: RevealMultiplier = 1;

export const revealMultiplierLabel = (multiplier: number) =>
  multiplier === 1 ? 'Normal' : `${multiplier}×`;

/**
 * The replay is watched deliberately, so it gets more room than an arrival
 * anyone might be reading past. Derived rather than a second setting: two
 * numbers to keep in step is two numbers to get out of step.
 */
export const REPLAY_MULTIPLIER = 8 / 3;

interface StickerRevealSpeedStore {
  multiplier: RevealMultiplier;
  setMultiplier: (multiplier: RevealMultiplier) => void;
}

export const useStickerRevealSpeedStore = create<StickerRevealSpeedStore>()(
  persist(
    (set) => ({
      multiplier: DEFAULT_REVEAL_MULTIPLIER,
      setMultiplier: (multiplier) => set({ multiplier }),
    }),
    {
      // A new key rather than a version bump on the old one: the previous
      // setting stored a duration in milliseconds, and 3000 read back as a
      // multiplier is a reveal three thousand times too long.
      name: 'sticker-reveal-multiplier',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export const useRevealMultiplier = () => useStickerRevealSpeedStore((state) => state.multiplier);
