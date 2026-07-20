import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface LastUsedBaseModelStore {
  lastUsedBaseModel?: string;
  setLastUsedBaseModel: (baseModel: string) => void;
}

export const useLastUsedBaseModelStore = create<LastUsedBaseModelStore>()(
  persist(
    (set) => ({
      lastUsedBaseModel: undefined,
      setLastUsedBaseModel: (baseModel) => set({ lastUsedBaseModel: baseModel }),
    }),
    {
      name: 'last-used-base-model',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export const lastUsedBaseModelStore = {
  get: () => useLastUsedBaseModelStore.getState().lastUsedBaseModel,
  set: (baseModel: string) => useLastUsedBaseModelStore.getState().setLastUsedBaseModel(baseModel),
};
