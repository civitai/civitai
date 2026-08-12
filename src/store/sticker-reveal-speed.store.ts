import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * How long the whole sticker reveal takes, end to end.
 *
 * A ceiling on the sequence rather than a per-sticker delay: the gaps between
 * placements are what set the rhythm, and this decides how much room the whole
 * thing gets. Forty stickers and four stickers both finish inside it.
 */
export const REVEAL_DURATIONS = [1_500, 3_000, 6_000, 12_000] as const;

export type RevealDuration = (typeof REVEAL_DURATIONS)[number];

export const DEFAULT_REVEAL_DURATION: RevealDuration = 3_000;

export const revealDurationLabel = (ms: number) => `${ms / 1000}s`;

/**
 * The replay is watched deliberately, so it gets more room than an arrival
 * anyone might be reading past. Derived rather than a second setting: two
 * numbers to keep in step is two numbers to get out of step, and nobody asked
 * to pace the two independently.
 */
export const REPLAY_MULTIPLIER = 8 / 3;

interface StickerRevealSpeedStore {
  durationMs: RevealDuration;
  setDuration: (durationMs: RevealDuration) => void;
}

export const useStickerRevealSpeedStore = create<StickerRevealSpeedStore>()(
  persist(
    (set) => ({
      durationMs: DEFAULT_REVEAL_DURATION,
      setDuration: (durationMs) => set({ durationMs }),
    }),
    {
      name: 'sticker-reveal-speed',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export const useRevealDuration = () => useStickerRevealSpeedStore((state) => state.durationMs);
