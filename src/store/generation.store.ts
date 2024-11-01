import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { GenerationData } from '~/server/services/generation/generation.service';
import { QS } from '~/utils/qs';

export type RunType = 'run' | 'remix' | 'params' | 'replay';
export type GenerationType = 'image' | 'video';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';
type GenerationState = {
  opened: boolean;
  view: GenerationPanelView;
  type: GenerationType;
  data?: GenerationData & { runType: RunType };
  // input?: GetGenerationDataInput;
  // used to populate form with model/image generation data
  open: (input?: GetGenerationDataInput) => Promise<void>;
  close: () => void;
  setView: (view: GenerationPanelView) => void;
  setType: (type: GenerationType) => void;
  setData: (args: GenerationData & { view?: GenerationPanelView; type: GenerationType }) => void;
  clearData: () => void;
};

export const useGenerationStore = create<GenerationState>()(
  devtools(
    immer((set) => ({
      opened: false,
      view: 'generate',
      type: 'video', // TODO - set default to 'image' before sending to prod
      open: async (input) => {
        set((state) => {
          state.opened = true;
          if (input) {
            state.view = 'generate';
            if (input.type === 'video') state.type = 'video';
            else state.type = 'image';
          }
        });

        if (input) {
          const response = await fetchGenerationData(input);
          set((state) => {
            state.data = { ...response, runType: input.type === 'image' ? 'remix' : 'run' };
          });
        }
      },
      close: () =>
        set((state) => {
          state.opened = false;
        }),
      setView: (view) =>
        set((state) => {
          state.view = view;
        }),
      setType: (type) => {
        set((state) => {
          state.type = type;
        });
      },
      setData: ({ view, type, ...data }) =>
        set((state) => {
          state.type = type;
          state.view = view ?? 'generate';
          state.data = { ...data, runType: 'replay' };
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
  setType: store.setType,
};

export const generationStore = {
  setData: store.setData,
  clearData: store.clearData,
};

const dictionary: Record<string, GenerationData> = {};
export const fetchGenerationData = async (input: GetGenerationDataInput) => {
  let key = 'default';
  switch (input.type) {
    case 'image':
    case 'modelVersion':
      key = `${input.type}_${input.id}`;
      break;
    case 'modelVersions':
      key = `${input.type}_${input.ids.join('_')}`;
      break;
  }

  if (dictionary[key]) return dictionary[key];
  else {
    const response = await fetch(`/api/generation/data?${QS.stringify(input)}`);
    if (!response.ok) throw new Error(response.statusText);
    const data: GenerationData = await response.json();
    dictionary[key] = data;
    return data;
  }
};
