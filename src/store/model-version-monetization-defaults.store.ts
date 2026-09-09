import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { MonetizationDefaults } from '~/components/Resource/Forms/model-version-monetization-defaults';

interface MonetizationDefaultsStore {
  /**
   * Keyed by ModelType. Read back as `unknown` on purpose — what a browser has stored was written by
   * whatever build it last used, so the caller parses it against the current shape.
   */
  byModelType: Record<string, unknown>;
  setDefaults: (modelType: string, defaults: MonetizationDefaults) => void;
}

export const useMonetizationDefaultsStore = create<MonetizationDefaultsStore>()(
  persist(
    (set) => ({
      byModelType: {},
      setDefaults: (modelType, defaults) =>
        set((state) => ({ byModelType: { ...state.byModelType, [modelType]: defaults } })),
    }),
    {
      name: 'model-version-monetization-defaults',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

export const monetizationDefaultsStore = {
  get: (modelType: string | null | undefined): unknown =>
    modelType ? useMonetizationDefaultsStore.getState().byModelType[modelType] : undefined,
  set: (modelType: string, defaults: MonetizationDefaults) =>
    useMonetizationDefaultsStore.getState().setDefaults(modelType, defaults),
};
