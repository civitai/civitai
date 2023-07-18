import { ModelType } from '@prisma/client';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { generation } from '~/server/common/constants';
import { GenerateFormModel, GetGenerationDataInput } from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { showErrorNotification } from '~/utils/notifications';
import { findClosest } from '~/utils/number-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { QS } from '~/utils/qs';

type RunType = 'run' | 'remix' | 'random' | 'params';
type View = 'queue' | 'generate' | 'feed';
type GenerationState = {
  opened: boolean;
  view: View;
  data?: { type: RunType; data: Partial<GenerateFormModel> };
  // used to populate form with model/image generation data
  open: (input?: GetGenerationDataInput) => Promise<void>;
  close: () => void;
  setView: (view: View) => void;
  randomize: (includeResources?: boolean) => Promise<void>;
  setParams: (data: Generation.Data['params']) => void;
  setData: (args: { data: Generation.Data; type: RunType }) => void;
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
        const type = input.type === 'model' ? 'run' : input.type === 'image' ? 'remix' : 'random';
        if (data) get().setData({ type, data });
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
        const data = formatGenerationData({ resources: [], params });
        set((state) => {
          state.data = { type: 'params', data };
        });
      },
      setData: ({ data, type }) =>
        set((state) => {
          state.view = 'generate';
          state.data = { type, data: formatGenerationData(data) };
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

const formatGenerationData = ({
  resources,
  params,
}: Generation.Data): Partial<GenerateFormModel> => {
  const additionalResources = resources.filter((x) =>
    generation.additionalResourceTypes.includes(x.modelType as any)
  );
  const aspectRatio =
    params?.height && params.width ? getClosestAspectRatio(params.width, params.height) : undefined;

  let sampler = params?.sampler;
  if (sampler) sampler = generation.samplers.includes(sampler as any) ? sampler : undefined;

  const formData: Partial<GenerateFormModel> = {
    model: resources.find((x) => x.modelType === ModelType.Checkpoint),
    vae: resources.find((x) => x.modelType === ModelType.VAE),
    aspectRatio,
    ...params,
    sampler,
    // seed: params?.seed === -1 ? undefined : params?.seed,
  };
  return {
    ...removeEmpty(formData),
    resources: !!additionalResources.length ? additionalResources : undefined,
  };
};

export const getClosestAspectRatio = (width = 512, height = 512) => {
  const ratios = generation.aspectRatios.map((x) => x.width / x.height);
  const closest = findClosest(ratios, width / height);
  const index = ratios.indexOf(closest);
  const supported = generation.aspectRatios[index] ?? { width: 512, height: 512 };
  return `${supported.width}x${supported.height}`;
};
