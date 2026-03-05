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
import {
  getOutputTypeForWorkflow,
  isNewFormOnly,
} from '~/shared/data-graph/generation/config/workflows';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import { getEngineFromEcosystem } from '~/shared/utils/engine.utils';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { generationFormStore } from '~/store/generation-form.store';
import { remixStore } from '~/store/remix.store';
import { trpcVanilla } from '~/utils/trpc';

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
  /** Resources in full GenerationResource format */
  resources: GenerationResource[];
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

/**
 * TEMPORARY: Sync legacy form store when graph data changes.
 * Sets the correct media type and video engine so the legacy form
 * shows the right UI. Remove when legacy generator is removed.
 * See docs/legacy-generator-files.md
 */
function syncLegacyFormStore(params: Record<string, unknown>, resources?: GenerationResource[]) {
  const workflow = params.workflow as string | undefined;
  const ecosystem = params.ecosystem as string | undefined;

  // Skip sync for new-form-only data — the legacy form provider will show
  // the switch-to-new-form modal instead.
  if (workflow) {
    const ecosystemId = ecosystem ? ecosystemByKey.get(ecosystem)?.id : undefined;
    const checkpointModelId = resources?.find((r) => r.model.type === 'Checkpoint')?.id;
    if (isNewFormOnly(workflow, ecosystemId, checkpointModelId)) return;
  }

  if (workflow) {
    const outputType = getOutputTypeForWorkflow(workflow);
    generationFormStore.setType(outputType);

    if (outputType === 'video' && ecosystem) {
      const engine = getEngineFromEcosystem(ecosystem) as OrchestratorEngine2 | undefined;
      if (engine) {
        generationFormStore.setEngine(engine);
      }
    }
  }
}

/** Apply resource substitutions (use substitute if original can't generate) */
function substituteResource(item: GenerationResource): GenerationResource {
  const { substitute, ...rest } = item;
  if (!rest.canGenerate && substitute?.canGenerate) return { ...item, ...substitute };
  return rest;
}

/** Build a normalized cache key for a generation data request.
 *
 * `modelVersion` (single ID) and `modelVersions` ([single ID]) share the same
 * key so parallel or sequential calls for the same model version are deduplicated.
 * Multi-ID `modelVersions` requests use a sorted key to be order-independent.
 */
function buildGenerationDataKey(input: GetGenerationDataInput): string {
  switch (input.type) {
    case 'modelVersion':
      return `model_${input.id}${input.epoch ? `_e${input.epoch}` : ''}`;
    case 'modelVersions': {
      const ids = (Array.isArray(input.ids) ? input.ids : [input.ids])
        .slice()
        .sort((a, b) => a - b);
      return `model_${ids.join('_')}`;
    }
    default:
      return `media_${input.id}`;
  }
}

/**
 * In-flight + resolved promise cache.
 * Caching the Promise (not just the resolved value) deduplicates parallel
 * calls with the same key — the second caller awaits the same in-flight request.
 */
const generationDataCache = new Map<string, Promise<GenerationData>>();

export function fetchGenerationData(input: GetGenerationDataInput): Promise<GenerationData> {
  const key = buildGenerationDataKey(input);

  const cached = generationDataCache.get(key);
  if (cached) return cached;

  const promise = trpcVanilla.generation.getGenerationData
    .query({ ...input, withPreview: true })
    .then((data) => data as GenerationData)
    .catch((err) => {
      generationDataCache.delete(key); // Allow retry on failure
      throw err;
    });

  generationDataCache.set(key, promise);
  return promise;
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
            const resources = result.resources.map(substituteResource);

            // When remixing enhancement workflows (hires-fix, face-fix), fall back to
            // txt2img so the user gets a standard generation form.
            if (isMedia) {
              const REMIX_WORKFLOW_OVERRIDES: Record<string, string> = {
                'txt2img:hires-fix': 'txt2img',
                'img2img:hires-fix': 'txt2img',
                'txt2img:face-fix': 'txt2img',
                'img2img:face-fix': 'txt2img',
              };
              const w = result.params.workflow as string | undefined;
              if (w && REMIX_WORKFLOW_OVERRIDES[w]) {
                result.params.workflow = REMIX_WORKFLOW_OVERRIDES[w];
              }
            }

            // TEMPORARY: Sync legacy form store (remove with legacy generator)
            syncLegacyFormStore(result.params, resources);

            // Update remix store for similarity tracking
            if (isMedia && result.remixOfId) {
              remixStore.setRemix(result.remixOfId, result.params);
            }

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
        // TEMPORARY: Sync legacy form store (remove with legacy generator)
        syncLegacyFormStore(params, resources);

        if (typeof window !== 'undefined' && !location.pathname.startsWith('/generate'))
          useGenerationPanelStore.setState({ view: 'generate' });

        // Update remix store for similarity tracking
        if ((runType === 'remix' || runType === 'replay') && remixOfId) {
          remixStore.setRemix(remixOfId, params);
        }

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
  /** Save the current panel view so it can be restored after an enhancement workflow */
  setViewWithReturn: (view: 'generate' | 'queue' | 'feed') => {
    const { view: currentView } = useGenerationPanelStore.getState();
    useGenerationPanelStore.setState({ view, previousView: currentView });
  },
  /** Restore the previously saved panel view (clears previousView) */
  restorePreviousView: () => {
    const { previousView } = useGenerationPanelStore.getState();
    if (previousView) {
      useGenerationPanelStore.setState({ view: previousView, previousView: undefined });
    }
  },
};

export const generationGraphStore = {
  setData: store.setData,
  clearData: store.clearData,
  getState: useGenerationGraphStore.getState,
};
