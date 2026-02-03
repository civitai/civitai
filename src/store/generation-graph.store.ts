/**
 * Generation Graph Store
 *
 * Store for passing generation data to the DataGraph-based form.
 * Handles opening the generation sidebar, fetching generation data,
 * and providing graph-compatible data to GenerationFormProvider.
 */

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { GetGenerationDataInput } from '~/server/schema/generation.schema';
import type { GenerationData } from '~/server/services/generation/generation.service';
import type { ResourceData } from '~/shared/data-graph/generation/common';
import type { GenerationResource } from '~/shared/types/generation.types';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { QS } from '~/utils/qs';

// =============================================================================
// Types
// =============================================================================

export type RunType = 'run' | 'remix' | 'replay' | 'patch';

/**
 * Graph-compatible generation data.
 * Params should already be in graph format (workflow, baseModel, aspectRatio as object, etc.)
 */
export interface GenerationGraphData {
  /** Params from step.metadata.params or fetched generation data */
  params: Record<string, unknown>;
  /** Resources in ResourceData format (matching data-graph resourceSchema) */
  resources: ResourceData[];
  /** Type of run (determines reset behavior in form provider) */
  runType: RunType;
  /** Optional remix reference */
  remixOfId?: number;
}

interface GenerationGraphState {
  /** Counter for change detection (increments on each setData) */
  counter: number;
  /** Whether generation data is being fetched */
  loading: boolean;
  /** Pending data to apply to the form */
  data?: GenerationGraphData;
  /** Open the generation sidebar, optionally fetching data for a model/image */
  open: (input?: GetGenerationDataInput) => Promise<void>;
  /** Close the generation sidebar */
  close: () => void;
  /** Set generation data for the form to consume */
  setData: (data: Omit<GenerationGraphData, 'runType'> & { runType?: RunType }) => void;
  /** Clear pending data (called by form provider after consuming) */
  clearData: () => void;
}

// =============================================================================
// Helpers
// =============================================================================

/** Convert GenerationResource to ResourceData (matching data-graph resourceSchema) */
function toResourceData(r: GenerationResource): ResourceData {
  return {
    id: r.id,
    baseModel: r.baseModel,
    model: { type: r.model.type },
    strength: r.strength,
    trainedWords: r.trainedWords.length > 0 ? r.trainedWords : undefined,
    epochDetails: r.epochDetails ? { epochNumber: r.epochDetails.epochNumber } : undefined,
  };
}

/** Apply resource substitutions (use substitute if original can't generate) */
function substituteResource(item: GenerationResource): GenerationResource {
  const { substitute, ...rest } = item;
  if (!rest.canGenerate && substitute?.canGenerate) return { ...item, ...substitute };
  return rest;
}

/** Fetch generation data from the API with caching */
const dictionary: Record<string, GenerationData> = {};
export async function fetchGenerationData(input: GetGenerationDataInput): Promise<GenerationData> {
  let key = 'default';
  switch (input.type) {
    case 'modelVersions':
      key = `${input.type}_${Array.isArray(input.ids) ? input.ids.join('_') : input.ids}`;
      break;
    case 'modelVersion':
      key = `${input.type}_${input.id}${input.epoch ? `_${input.epoch}` : ''}`;
      break;
    default:
      key = `media_${input.id}`;
      break;
  }

  if (dictionary[key]) return dictionary[key];
  const response = await fetch(`/api/generation/data?${QS.stringify(input)}`);
  if (!response.ok) throw new Error(response.statusText);
  const data: GenerationData = await response.json();
  dictionary[key] = data;
  return data;
}

// =============================================================================
// Store
// =============================================================================

export const useGenerationGraphStore = create<GenerationGraphState>()(
  devtools(
    immer((set) => ({
      counter: 0,
      loading: false,
      data: undefined,

      open: async (input) => {
        useGenerationPanelStore.setState({ opened: true });
        if (input) {
          useGenerationPanelStore.setState({ view: 'generate' });
          set((state) => {
            state.loading = true;
          });

          try {
            const result = await fetchGenerationData(input);
            const isMedia = ['audio', 'image', 'video'].includes(input.type);
            const resources = result.resources.map(substituteResource).map(toResourceData);

            set((state) => {
              state.data = {
                params: result.params,
                resources,
                runType: isMedia ? 'remix' : 'run',
                remixOfId: result.remixOfId,
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

      close: () => useGenerationPanelStore.setState({ opened: false }),

      setData: ({ params, resources, runType = 'replay', remixOfId }) => {
        set((state) => {
          state.data = {
            params,
            resources,
            runType,
            remixOfId,
          };
          state.counter++;
        });
      },

      clearData: () => {
        set((state) => {
          state.data = undefined;
        });
      },
    })),
    { name: 'generation-graph-store' }
  )
);

// =============================================================================
// Convenience API
// =============================================================================

const store = useGenerationGraphStore.getState();

export const generationGraphPanel = {
  open: store.open,
  close: store.close,
  setView: (view: 'generate' | 'queue' | 'feed') => useGenerationPanelStore.setState({ view }),
};

export const generationGraphStore = {
  setData: store.setData,
  clearData: store.clearData,
  getState: useGenerationGraphStore.getState,
};
