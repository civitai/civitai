import { create } from 'zustand';
import type { StickerTrackKey } from '~/shared/utils/sticker-track';

/**
 * Auto-track runs by draft id. Apart from the draft store because a run outlives the editor that
 * started it (the tray opening unmounts it) but not the page, as drafts do.
 */
export type StickerAutoTrackRun =
  | { phase: 'tracking'; workflowId: string; startMs: number; startedAt: number }
  /** `before` is the draft's keys before the run landed, for Discard over `startMs`..`endMs`. */
  | {
      phase: 'ready';
      added: number;
      hides: number;
      before: StickerTrackKey[];
      startMs: number;
      endMs: number;
    }
  | { phase: 'failed'; message: string };

type State = {
  runs: Record<string, StickerAutoTrackRun>;
  set: (draftId: string, run: StickerAutoTrackRun) => void;
  clear: (draftId: string) => void;
};

export const useStickerAutoTrackStore = create<State>()((set) => ({
  runs: {},
  set: (draftId, run) => set((state) => ({ runs: { ...state.runs, [draftId]: run } })),
  clear: (draftId) =>
    set((state) => {
      const { [draftId]: _, ...runs } = state.runs;
      return { runs };
    }),
}));
