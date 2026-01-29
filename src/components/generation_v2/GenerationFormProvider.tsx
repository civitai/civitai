/**
 * GenerationFormProvider
 *
 * Provider wrapper that sets up the DataGraph context for the generation form.
 * This includes the graph, storage adapter, and external context.
 */

import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { DataGraphProvider, useDataGraph } from '~/libs/data-graph/react';
import { createLocalStorageAdapter } from '~/libs/data-graph/storage-adapter';
import { generationGraph, type GenerationCtx } from '~/shared/data-graph/generation';
import {
  useGenerationStore,
  useGenerationFormStore,
  generationStore,
} from '~/store/generation.store';

import { ResourceDataProvider, useResourceDataContext } from './inputs/ResourceDataProvider';
import { WhatIfProvider } from './WhatIfProvider';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY = 'data-graph-v2';

// =============================================================================
// Storage Adapter
// =============================================================================

const storageAdapter = createLocalStorageAdapter({
  prefix: STORAGE_KEY,
  groups: [
    // Workflow is the primary selector - stored globally
    { keys: ['workflow', 'outputFormat', 'priority'] },
    { name: 'output', keys: ['baseModel'], scope: 'output' },
    { name: 'common', keys: ['prompt', 'negativePrompt', 'seed', 'quantity'] },
    // baseModel is scoped to workflow (different workflows may use different ecosystems)
    // { name: 'workflow', keys: ['baseModel'], scope: 'workflow' },
    {
      name: 'workflow',
      keys: ['quantity'],
      scope: 'workflow',
      condition: (ctx) => ctx.workflow === 'txt2img:draft',
    },
    // Model-family specific settings scoped to baseModel
    // Values for inactive nodes are automatically retained in storage
    // (e.g., cfgScale/steps when switching to Ultra mode which doesn't have them)
    { name: 'scoped', keys: '*', scope: 'baseModel' },
    // Fallback for non-ecosystem workflows (upscale, interpolate, etc.)
    // These workflows don't have baseModel, so the above group is skipped
    // and this catch-all handles remaining keys at workflow scope
    { name: 'workflow', keys: '*', scope: 'workflow' },
  ],
});

// =============================================================================
// Types
// =============================================================================

export interface GenerationFormProviderProps {
  children: ReactNode;
  /** Default/initial values to pass to graph.init() (e.g., from API data) */
  defaultValues?: Record<string, unknown>;
  /** Enable debug mode for the graph */
  debug?: boolean;
  /** Skip loading values from localStorage (use only defaultValues and node defaults) */
  skipStorage?: boolean;
}

// =============================================================================
// Inner Component (has access to ResourceDataProvider context)
// =============================================================================

function InnerProvider({
  children,
  defaultValues,
  debug = false,
  skipStorage = false,
}: GenerationFormProviderProps) {
  const status = useGenerationStatus();
  const { resources } = useResourceDataContext();

  // Build external context from generation status and resource data
  const externalContext = useMemo<GenerationCtx>(
    () => ({
      limits: {
        maxQuantity: status.limits.quantity,
        maxResources: status.limits.resources,
      },
      user: {
        isMember: status.tier !== 'free',
        tier: status.tier,
      },
      resources,
    }),
    [status.limits.quantity, status.limits.resources, status.tier, resources]
  );

  // Initialize the DataGraph (clone, attach storage, init once)
  const { graph } = useDataGraph({
    graph: generationGraph,
    storage: storageAdapter,
    defaultValues,
    externalContext,
    debug,
    skipStorage,
  });

  // Sync generation store data into the graph
  // - Remix/Replay: full override (reset + set)
  // - Run/Patch: partial update (set only)
  const prevCounterRef = useRef(0);
  useEffect(() => {
    function applyStoreData() {
      const { data, counter } = useGenerationStore.getState();
      if (!data || counter === prevCounterRef.current) return;
      prevCounterRef.current = counter;

      const { workflow } = useGenerationFormStore.getState();
      const values = {
        ...data.params,
        workflow: workflow ?? data.params.workflow ?? data.params.process,
        model: data.model,
        resources: data.resources,
        vae: data.vae,
      };

      if (data.runType === 'remix' || data.runType === 'replay') {
        graph.reset();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose superset of discriminated union
      graph.set(values as any);

      generationStore.clearData();
    }

    // Check on mount (data may arrive before component mounts)
    applyStoreData();

    // Subscribe to future changes
    return useGenerationStore.subscribe(applyStoreData);
  }, [graph]);

  return (
    <DataGraphProvider graph={graph}>
      <WhatIfProvider>{children}</WhatIfProvider>
    </DataGraphProvider>
  );
}

// =============================================================================
// Component
// =============================================================================

export function GenerationFormProvider({
  children,
  defaultValues,
  debug = false,
  skipStorage = false,
}: GenerationFormProviderProps) {
  return (
    <ResourceDataProvider>
      <InnerProvider defaultValues={defaultValues} debug={debug} skipStorage={skipStorage}>
        {children}
      </InnerProvider>
    </ResourceDataProvider>
  );
}
