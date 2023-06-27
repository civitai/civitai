import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type GenerationStore = {
  drawerOpened: boolean;
  modelVersionId?: number;
  imageId?: number;
  activeTab: string;

  setActiveTab: (value: string) => void;
  toggleDrawer: (args?: { imageId?: number; modelVersionId?: number }) => void;
};

export const useGenerationStore = create<GenerationStore>()(
  immer((set) => ({
    drawerOpened: false,
    activeTab: 'queue',

    setActiveTab: (value) => {
      set((state) => {
        state.activeTab = value;
      });
    },
    toggleDrawer: (args) => {
      set((state) => {
        if (state.drawerOpened) {
          state.drawerOpened = false;
          state.modelVersionId = undefined;
          state.imageId = undefined;
        } else {
          state.drawerOpened = true;
          state.activeTab = 'generate';
          state.modelVersionId = args?.modelVersionId;
          state.imageId = args?.imageId;
        }
      });
    },
  }))
);
