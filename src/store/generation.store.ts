import { MediaType } from '~/shared/utils/prisma/enums';
import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import {
  GenerationData,
  GenerationResourceSimple,
  RemixOfProps,
} from '~/server/services/generation/generation.service';
import {
  engineDefinitions,
  generationFormWorkflowConfigurations,
} from '~/shared/constants/generation.constants';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export type RunType = 'run' | 'remix' | 'replay';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';
type GenerationState = {
  opened: boolean;
  view: GenerationPanelView;
  type: MediaType;
  remixOf?: RemixOfProps;
  data?: GenerationData & { runType: RunType };
  // input?: GetGenerationDataInput;
  // used to populate form with model/image generation data
  open: (input?: GetGenerationDataInput) => Promise<void>;
  close: () => void;
  setView: (view: GenerationPanelView) => void;
  setType: (type: MediaType) => void;
  setData: (
    args: GenerationData & {
      type: MediaType;
      workflow?: string;
      sourceImage?: string;
      engine?: string;
    }
  ) => void;
  clearData: () => void;
};

export const useGenerationStore = create<GenerationState>()(
  devtools(
    immer((set) => ({
      opened: false,
      view: 'generate',
      type: 'image',
      open: async (input) => {
        set((state) => {
          state.opened = true;
          if (input) {
            state.view = 'generate';
          }
        });

        if (input) {
          const isMedia = ['audio', 'image', 'video'].includes(input.type);
          if (isMedia) {
            generationFormStore.setType(input.type as MediaType);
          }
          const result = await fetchGenerationData(input);
          if (isMedia) {
            useRemixStore.setState(result);
          }

          const { remixOf, ...data } = result;
          set((state) => {
            state.data = { ...data, runType: input.type === 'image' ? 'remix' : 'run' };
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
      setData: ({ type, remixOf, workflow, sourceImage, engine, ...data }) => {
        useGenerationFormStore.setState({ type, workflow, sourceImage });
        if (engine) useGenerationFormStore.setState({ engine });
        set((state) => {
          state.remixOf = remixOf;
          state.data = { ...data, runType: 'replay' };
          if (!location.pathname.includes('generate')) state.view = 'generate';
        });
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
  setType: store.setType,
  setData: store.setData,
  clearData: store.clearData,
  // getSupplementaryFormData() {
  //   const { remixOf, type } = useGenerationStore.getState();
  //   return { remixOf, type };
  // },
};

const dictionary: Record<string, GenerationData> = {};
export const fetchGenerationData = async (input: GetGenerationDataInput) => {
  let key = 'default';
  switch (input.type) {
    case 'modelVersions':
      key = `${input.type}_${input.ids.join('_')}`;
      break;
    default:
      key = `${input.type}_${input.id}`;
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

export const useGenerationFormStore = create<{
  type: MediaType;
  engine?: string;
  workflow?: string; // is this needed?
  sourceImage?: string;
  width?: number;
  height?: number;
}>()(persist((set) => ({ type: 'image' }), { name: 'generation-form' }));

export const generationFormStore = {
  setType: (type: MediaType) => useGenerationFormStore.setState({ type }),
  setWorkflow: (workflow?: string) => {
    let updatedWorkflow = workflow;
    let engine: string | undefined;
    if (workflow) {
      const configuration = generationFormWorkflowConfigurations.find((x) => x.key === workflow);
      if (!configuration) updatedWorkflow = undefined;
      else {
        if ('engine' in configuration) engine = configuration.engine;
      }
    }

    useGenerationFormStore.setState({ workflow: updatedWorkflow, engine });
  },
  setEngine: (engine: string) => useGenerationFormStore.setState({ engine }),
  setsourceImage: (sourceImage?: string) => useGenerationFormStore.setState({ sourceImage }),
  reset: () => useGenerationFormStore.setState((state) => ({ type: state.type }), true),
};

export const useRemixStore = create<{
  resources?: GenerationResourceSimple[];
  params?: Record<string, unknown>;
  remixOf?: RemixOfProps;
}>()(persist(() => ({}), { name: 'remixOf' }));

export function useVideoGenerationWorkflows() {
  const { data, isLoading } = trpc.generation.getGenerationEngines.useQuery();
  const workflows = generationFormWorkflowConfigurations
    .map((config) => {
      const engine = data?.find((x) => x.engine === config.engine);
      if (!engine) return null;
      return { ...config, ...engine };
    })
    .filter(isDefined);

  const sourceImage = useGenerationFormStore((state) => state.sourceImage);
  const availableEngines = Object.keys(engineDefinitions)
    .filter((key) =>
      workflows
        ?.filter((x) => (sourceImage ? x.subType === 'img2vid' : x.subType === 'txt2vid'))
        .some((x) => x.engine === key && !x.disabled)
    )
    .map((key) => ({ key, ...engineDefinitions[key] }));

  return { data: workflows, availableEngines, isLoading };
}

export function useSelectedVideoWorkflow() {
  const { data } = useVideoGenerationWorkflows();
  const selectedEngine = useGenerationFormStore((state) => state.engine);
  const sourceImage = useGenerationFormStore((state) => state.sourceImage);
  const workflows = data.filter(({ subType, type }) =>
    type === 'video' && sourceImage ? subType.startsWith('img') : subType.startsWith('txt')
  );
  return workflows.find((x) => x.engine === selectedEngine) ?? workflows[0];
}
