import { useCallback } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type Selected = Record<string, Record<string, boolean>>;
const useStore = create<{
  selected: Selected;
  setSelected: (args: { workflowId: string; imageIds: string[] }[]) => void;
  toggle: (args: { workflowId: string; imageId: string }, value?: boolean) => void;
}>()(
  immer((set) => ({
    selected: {},
    setSelected: (args) =>
      set((state) => {
        state.selected = args.reduce<Selected>(
          (acc, { workflowId, imageIds }) => ({
            ...acc,
            [workflowId]: imageIds.reduce((acc, imageId) => ({ ...acc, [imageId]: true }), {}),
          }),
          {}
        );
      }),
    toggle: ({ workflowId, imageId }, value) =>
      set((state) => {
        const _value = value ?? !state.selected[workflowId]?.[imageId];
        if (_value) {
          if (!state.selected[workflowId]) state.selected[workflowId] = {};
          state.selected[workflowId][imageId] = true;
        } else {
          if (state.selected[workflowId]?.[imageId]) delete state.selected[workflowId][imageId];
          if (!Object.keys(state.selected[workflowId]).length) delete state.selected[workflowId];
        }
      }),
  }))
);

const mapSelected = (selected: Selected) => {
  return Object.entries(selected).map(([key, value]) => {
    return { workflowId: key, imageIds: Object.keys(value) };
  });
};

const useSelection = () => {
  const selected = useStore((state) => state.selected);
  return mapSelected(selected);
};

const useIsSelected = ({ workflowId, imageId }: { workflowId: string; imageId: string }) => {
  const selected = useStore(
    useCallback((state) => state.selected[workflowId]?.[imageId] ?? false, [workflowId, imageId])
  );
  return !!selected;
};

const getSelected = () => {
  const selected = useStore.getState().selected;
  return mapSelected(selected);
};

export const generationImageSelect = {
  useSelection,
  useIsSelected,
  setSelected: useStore.getState().setSelected,
  toggle: useStore.getState().toggle,
  getSelected,
};
