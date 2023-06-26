import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type GenerationStore = {
  drawerOpened: boolean;
  toggleDrawer: VoidFunction;
};

export const useGenerationStore = create<GenerationStore>()(
  immer((set) => ({
    drawerOpened: false,
    toggleDrawer: () => {
      set((state) => {
        state.drawerOpened = !state.drawerOpened;
      });
    },
  }))
);
