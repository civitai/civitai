import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * How much faster or slower than normal the viewer wants the reveal.
 *
 * A speed rather than a duration. The length itself comes from how old the
 * history is — a build spread over a year runs longer than an afternoon's — and
 * a viewer choosing an absolute number overrode exactly the thing that made the
 * reveal say anything. This scales that answer instead of replacing it.
 */
export const REVEAL_SPEEDS = [0.5, 1, 2, 4] as const;

export type RevealSpeed = (typeof REVEAL_SPEEDS)[number];

export const DEFAULT_REVEAL_SPEED: RevealSpeed = 1;

export const revealSpeedLabel = (speed: number) => (speed === 1 ? 'Normal' : `${speed}×`);

/**
 * The replay is watched deliberately, so it runs SLOWER than an arrival anyone
 * might be reading past — a speed below 1. Derived rather than a second setting:
 * two numbers to keep in step is two numbers to get out of step. The result is
 * clamped to the same cap, so no combination of settings produces a replay
 * nobody would sit through.
 */
export const REPLAY_SPEED = 3 / 8;

interface StickerRevealSpeedStore {
  speed: RevealSpeed;
  setSpeed: (speed: RevealSpeed) => void;
}

export const useStickerRevealSpeedStore = create<StickerRevealSpeedStore>()(
  persist(
    (set) => ({
      speed: DEFAULT_REVEAL_SPEED,
      setSpeed: (speed) => set({ speed }),
    }),
    {
      // A new key rather than a version bump on the old one: the previous
      // setting stored a duration in milliseconds, and 3000 read back as a
      // multiplier is a reveal three thousand times too long.
      // Renamed again, because the stored number's MEANING flipped: a saved 4
      // meant four times slower and now means four times faster.
      name: 'sticker-reveal-speed-v2',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export const useRevealSpeed = () => useStickerRevealSpeedStore((state) => state.speed);
