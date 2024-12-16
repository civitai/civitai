import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type StoreProps = {
  adUnits: Record<string, boolean>;
  enableAdUnit: (adUnit: string) => void;
  disableAdUnit: (adUnit: string) => void;
};

export const useAdUnitStore = create<StoreProps>()(
  immer((set) => ({
    adUnits: {},
    enableAdUnit: (adUnit) =>
      set((state) => {
        state.adUnits[adUnit] = true;
      }),
    disableAdUnit: (adUnit) =>
      set((state) => {
        state.adUnits[adUnit] = false;
      }),
  }))
);
