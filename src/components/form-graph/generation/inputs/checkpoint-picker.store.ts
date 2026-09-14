import { create } from 'zustand';

/**
 * The checkpoint picker's own ecosystem state, for the lifetime of one open.
 *
 * A store rather than component state because the rail and the consequence
 * footer render into two different slots of the shared resource modal — they
 * are siblings with no common ancestor to hold it.
 *
 * `committedEcosystem` lives here for a second reason: `dialogStore` captures a
 * modal's props once, so the ecosystem the picker opened on goes stale as soon
 * as the footer commits a different one. Tracking it in a closure variable does
 * not help — mutating one re-renders nothing. Both slots subscribe here, so a
 * commit updates the rail's highlight and the footer's copy together.
 */
type CheckpointPickerState = {
  pendingEcosystem?: string;
  committedEcosystem?: string;
  setPendingEcosystem: (ecosystemKey?: string) => void;
  setCommittedEcosystem: (ecosystemKey?: string) => void;
};

export const useCheckpointPickerStore = create<CheckpointPickerState>((set) => ({
  pendingEcosystem: undefined,
  committedEcosystem: undefined,
  setPendingEcosystem: (ecosystemKey) => set({ pendingEcosystem: ecosystemKey }),
  setCommittedEcosystem: (ecosystemKey) => set({ committedEcosystem: ecosystemKey }),
}));

/** Called on every open: no pending choice, committed to whatever the form has. */
export const resetCheckpointPicker = (ecosystemKey?: string) =>
  useCheckpointPickerStore.setState({
    pendingEcosystem: undefined,
    committedEcosystem: ecosystemKey,
  });
