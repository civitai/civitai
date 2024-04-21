import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { generation } from '~/server/common/constants';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { showErrorNotification } from '~/utils/notifications';
import { QS } from '~/utils/qs';

export type RunType = 'run' | 'remix' | 'random' | 'params';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';
type GenerationState = {
  opened: boolean;
  view: GenerationPanelView;
  data?: { type: RunType; data: Partial<Generation.Data> };
  // used to populate form with model/image generation data
  open: (input?: GetGenerationDataInput) => Promise<void>;
  close: () => void;
  setView: (view: GenerationPanelView) => void;
  randomize: (includeResources?: boolean) => Promise<void>;
  setParams: (data: Generation.Data['params']) => void;
  setData: (args: { data: Partial<Generation.Data>; type: RunType }) => void;
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
          if (input) state.view = 'generate';
        });

        if (!input) return;
        const data = await getGenerationData(input);
        const type =
          input.type === 'model' || input.type === 'modelVersion'
            ? 'run'
            : input.type === 'image'
            ? 'remix'
            : 'random';
        if (data) get().setData({ type, data: { ...data } });
      },
      close: () =>
        set((state) => {
          state.opened = false;
        }),
      setView: (view) =>
        set((state) => {
          state.view = view;
        }),
      setParams: (params) => {
        set((state) => {
          state.data = {
            type: 'params',
            data: { params },
          };
        });
      },
      setData: ({ data, type }) =>
        set((state) => {
          state.view = 'generate';
          if (
            data.params?.sampler &&
            !(generation.samplers as string[]).includes(data.params.sampler)
          )
            data.params.sampler = generation.defaultValues.sampler;
          state.data = { type, data };
        }),
      randomize: async (includeResources) => {
        const data = await getGenerationData({ type: 'random', includeResources });
        if (data) get().setData({ type: 'random', data });
      },
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
  setParams: store.setParams,
  clearData: store.clearData,
  randomize: store.randomize,
};

const dictionary: Record<string, Generation.Data> = {};
const getGenerationData = async (input: GetGenerationDataInput) => {
  try {
    const key = input.type !== 'random' ? `${input.type}_${input.id}` : undefined;
    if (key && dictionary[key]) return dictionary[key];
    else {
      const response = await fetch(`/api/generation/data?${QS.stringify(input)}`);
      if (!response.ok) throw new Error(response.statusText);
      const data: Generation.Data = await response.json();
      if (key) dictionary[key] = data;
      return data;
    }
  } catch (error: any) {
    showErrorNotification({ error });
  }
};
