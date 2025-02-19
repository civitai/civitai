import { useCallback } from 'react';
import { create } from 'zustand';
import { removeEmpty } from '~/utils/object-helpers';

type ModelVersionProps = {
  name?: string;
  hasAccess?: boolean;
};

type ModelVersionStore = {
  [key: number]: ModelVersionProps;
  setModelVersion: (id: number, data: ModelVersionProps) => void;
};

const useStore = create<ModelVersionStore>((set) => ({
  setModelVersion: (id, data) => set((state) => ({ [id]: { ...state[id], ...data } })),
}));

export const modelVersionStore = {
  setModelVersion: useStore.getState().setModelVersion,
};

export const useModelVersionStore = <T extends { id: number } & ModelVersionProps>(
  modelVersion: T
) => {
  return useStore(
    useCallback(
      (state) => {
        const stored = state[modelVersion.id] ?? {};
        return { ...modelVersion, ...removeEmpty(stored) };
      },
      [modelVersion]
    )
  );
};
