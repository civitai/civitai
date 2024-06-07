import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { generation } from '~/server/common/constants';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { GenerationData } from '~/server/services/generation/generation.service';

export type RunType = 'run' | 'remix' | 'params';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';
type GenerationState = {
  opened: boolean;
  view: GenerationPanelView;
  data?: Partial<GenerationData>;
  input?: GetGenerationDataInput;
  // used to populate form with model/image generation data
  open: (input?: GetGenerationDataInput) => Promise<void>;
  close: () => void;
  setView: (view: GenerationPanelView) => void;
  setData: (args: Partial<GenerationData>) => void;
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
        }),
      setData: (data) =>
        set((state) => {
          state.view = 'generate';
          if (
            data.params?.sampler &&
            !(generation.samplers as string[]).includes(data.params.sampler)
          )
            data.params.sampler = generation.defaultValues.sampler;
          state.data = data;
        }),
    })),
    { name: 'generation-store' }
  )
);

// useGenerationStore.subscribe((state) => {
//   if ((state.view !== 'generate' || !state.opened) && !!state.data) {
//     state.clearData();
//   }
// });

const store = useGenerationStore.getState();
export const generationPanel = {
  open: store.open,
  close: store.close,
  setView: store.setView,
};

export const generationStore = {
  setData: store.setData,
};
