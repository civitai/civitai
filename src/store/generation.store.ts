import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { GenerationData } from '~/server/services/generation/generation.service';

export type RunType = 'run' | 'remix' | 'params';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';
type GenerationState = {
  opened: boolean;
  view: GenerationPanelView;
  data?: GenerationData;
  input?: GetGenerationDataInput;
  // used to populate form with model/image generation data
  open: (input?: GetGenerationDataInput) => Promise<void>;
  close: () => void;
  setView: (view: GenerationPanelView) => void;
  setData: (args: GenerationData & { view?: GenerationPanelView }) => void;
  clearData: () => void;
};

export const useGenerationStore = create<GenerationState>()(
  devtools(
    immer((set, get) => ({
      opened: false,
      view: 'generate',
      open: async (input) => {
        set((state) => {
          state.opened = true;
          state.input = input;
          if (input) {
            state.view = 'generate';
            state.data = undefined;
          }
        });
      },
      close: () =>
        set((state) => {
          state.opened = false;
        }),
      setView: (view) =>
        set((state) => {
          state.view = view;
          state.input = undefined;
        }),
      setData: ({ view, ...data }) =>
        set((state) => {
          state.view = view ?? 'generate';
          state.data = data;
          state.input = undefined;
        }),
      clearData: () =>
        set((state) => {
          state.data = undefined;
        }),
    })),
    { name: 'generation-store' }
  )
);

const store = useGenerationStore.getState();
export const generationPanel = {
  open: store.open,
  close: store.close,
  setView: store.setView,
};

export const generationStore = {
  setData: store.setData,
  clearData: store.clearData,
};
