import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { GetGenerationDataInput } from '~/server/schema/generation.schema';
import {
  GenerationData,
  GenerationResource,
  RemixOfProps,
} from '~/server/services/generation/generation.service';
import {
  engineDefinitions,
  generationFormWorkflowConfigurations,
  getSourceImageFromUrl,
} from '~/shared/constants/generation.constants';
import { MediaType } from '~/shared/utils/prisma/enums';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export type RunType = 'run' | 'remix' | 'replay';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';
type GenerationState = {
  counter: number;
  loading: boolean;
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
      sourceImage?: SourceImageProps;
      engine?: string;
    }
  ) => void;
  clearData: () => void;
};

export const useGenerationStore = create<GenerationState>()(
  devtools(
    immer((set) => ({
      counter: 0,
      loading: false,
      opened: false,
      view: 'generate',
      type: 'image',
      open: async (input) => {
        set((state) => {
          state.opened = true;
          if (input) {
            state.view = 'generate';
            state.loading = true;
          }
        });

        if (input) {
          const isMedia = ['audio', 'image', 'video'].includes(input.type);
          // if (isMedia) {
          //   generationFormStore.setType(input.type as MediaType);
          // }
          try {
            const result = await fetchGenerationData(input);
            const { remixOf, ...data } = result;
            const { params } = await transformParams(data.params, remixOf);
            if (params.engine)
              useGenerationFormStore.setState({ engine: params.engine, type: data.type });

            if (isMedia) {
              useRemixStore.setState({
                ...result,
                params,
                resources: withSubstitute(result.resources),
              });
            }

            set((state) => {
              state.data = {
                ...data,
                params,
                resources: withSubstitute(data.resources),
                runType: input.type === 'image' ? 'remix' : 'run',
              };
              state.loading = false;
              state.counter++;
            });
          } catch (e) {
            set((state) => {
              state.loading = false;
            });
            throw e;
          }
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
      setData: async ({ type, remixOf, workflow, sourceImage, engine, ...data }) => {
        // TODO.Briant - cleanup at a later point in time
        useGenerationFormStore.setState({ type, workflow });
        if (sourceImage) generationFormStore.setsourceImage(sourceImage);
        if (engine) useGenerationFormStore.setState({ engine });
        const { params } = await transformParams(data.params);
        set((state) => {
          state.remixOf = remixOf;
          state.data = {
            ...data,
            type,
            params,
            resources: withSubstitute(data.resources),
            runType: 'replay',
          };
          state.counter++;
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

function withSubstitute(resources: GenerationResource[]) {
  return resources.map((item) => {
    const { substitute, ...rest } = item;
    if (!rest.canGenerate && substitute?.canGenerate) return { ...item, ...substitute };
    return rest;
  });
}

// const stripWeightDate = new Date('03-14-2025');
async function transformParams(
  data: Record<string, any>,
  remixOf?: RemixOfProps
): Promise<{ params: Record<string, any> }> {
  let sourceImage = data.sourceImage;
  if (!sourceImage) {
    if ('image' in data && typeof data.image === 'string')
      sourceImage = await getSourceImageFromUrl({ url: data.image });
  } else if ('sourceImage' in data && typeof data.sourceImage === 'string')
    sourceImage = await getSourceImageFromUrl({ url: data.sourceImage });

  const params: Record<string, any> = { ...data, sourceImage };

  // if (remixOf && new Date(remixOf.createdAt) < stripWeightDate) {
  //   if (data.prompt) params.prompt = data.prompt.replace(/\(*([^():,]+)(?::[0-9.]+)?\)*/g, `$1`);
  //   if (data.negativePrompt)
  //     params.negativePrompt = data.negativePrompt.replace(/\(*([^():,]+)(?::[0-9.]+)?\)*/g, `$1`);
  // }

  return {
    params,
  };
}

const dictionary: Record<string, GenerationData> = {};
export const fetchGenerationData = async (input: GetGenerationDataInput) => {
  let key = 'default';
  switch (input.type) {
    case 'modelVersions':
      key = `${input.type}_${Array.isArray(input.ids) ? input.ids.join('_') : input.ids}_${(
        (input.epochNumbers as string[]) ?? []
      )?.join('_')}`;
      break;
    case 'modelVersion':
      key = `${input.type}_${input.id}_${((input.epochNumbers as string[]) ?? [])?.join('_')}`;
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
  sourceImage?: SourceImageProps | null;
  width?: number;
  height?: number;
  // originalPrompt?: string;
}>()(persist((set) => ({ type: 'image' }), { name: 'generation-form', version: 1.2 }));

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
  setsourceImage: async (sourceImage?: SourceImageProps | string | null) => {
    useGenerationFormStore.setState({
      sourceImage:
        typeof sourceImage === 'string'
          ? await getSourceImageFromUrl({ url: sourceImage })
          : sourceImage,
    });
  },
  reset: () => useGenerationFormStore.setState((state) => ({ type: state.type }), true),
};

export const useRemixStore = create<{
  resources?: GenerationResource[];
  params?: Record<string, unknown>;
  remixOf?: RemixOfProps;
  remixOfId?: number;
}>()(persist(() => ({}), { name: 'remixOf' }));

export function useVideoGenerationWorkflows() {
  const currentUser = useCurrentUser();
  // TODO - handle member only
  const isMember = currentUser?.isPaidMember ?? false;
  const { data, isLoading } = trpc.generation.getGenerationEngines.useQuery();
  const workflows = generationFormWorkflowConfigurations
    .map((config) => {
      const engine = data?.find((x) => x.engine === config.engine);
      if (
        !engine ||
        (engine.status === 'mod-only' && !currentUser?.isModerator) ||
        engine.status === 'disabled'
      )
        return null;
      return { ...config, ...engine, memberOnly: engine.memberOnly };
    })
    .filter(isDefined);

  const availableEngines = Object.keys(engineDefinitions)
    .filter((key) => workflows?.some((x) => x.engine === key))
    .map((key) => ({ key, ...engineDefinitions[key] }));

  return { data: workflows, availableEngines, isLoading };
}

export function useSelectedVideoWorkflow() {
  const { data, availableEngines } = useVideoGenerationWorkflows();
  const selectedEngine = useGenerationFormStore((state) => state.engine);
  const sourceImage = useGenerationFormStore((state) => state.sourceImage);
  let workflowsByEngine = data.filter((x) => x.engine === selectedEngine);
  if (!workflowsByEngine.length)
    workflowsByEngine = data.filter((x) => x.engine === availableEngines[0].key);

  return (
    workflowsByEngine.find(({ subType, type }) =>
      type === 'video' && sourceImage ? subType.startsWith('img') : subType.startsWith('txt')
    ) ?? workflowsByEngine[0]
  );
}
