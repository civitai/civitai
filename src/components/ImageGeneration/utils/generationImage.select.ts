import { useCallback } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

// =============================================================================
// Key helpers
// =============================================================================

const makeKey = (image: { workflowId: string; stepName: string; id: string }) =>
  `${image.workflowId}:${image.stepName}:${image.id}`;

// =============================================================================
// Store (plain zustand — no immer, BlobData has private fields)
// =============================================================================

interface OrchestratorImageSelectState {
  selected: Record<string, BlobData>;
}

const initialState: OrchestratorImageSelectState = {
  selected: {},
};

const useStore = create<OrchestratorImageSelectState>()(
  devtools(() => initialState, { name: 'generated-image-select' })
);

// =============================================================================
// Public API
// =============================================================================

export const orchestratorImageSelect = {
  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  useSelection: (): BlobData[] => {
    const selected = useStore((state) => state.selected);
    return Object.values(selected);
  },

  useIsSelected: (image: { workflowId: string; stepName: string; id: string }): boolean => {
    const key = makeKey(image);
    return useStore(useCallback((state) => !!state.selected[key], [key]));
  },

  useIsSelecting: (): boolean => {
    return useStore((state) => Object.keys(state.selected).length > 0);
  },

  setSelected: (images: BlobData[]) => {
    useStore.setState({
      selected: Object.fromEntries(images.map((img) => [makeKey(img), img])),
    });
  },

  toggle: (image: BlobData, value?: boolean) => {
    const state = useStore.getState();
    const key = makeKey(image);
    const isSelected = !!state.selected[key];
    const newValue = value ?? !isSelected;

    if (newValue === isSelected) return;

    if (newValue) {
      useStore.setState({ selected: { ...state.selected, [key]: image } });
    } else {
      const { [key]: _, ...rest } = state.selected;
      useStore.setState({ selected: rest });
    }
  },

  getSelected: (): BlobData[] => {
    return Object.values(useStore.getState().selected);
  },
};
