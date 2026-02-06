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
import type { ResourceData } from '~/shared/data-graph/generation/common';
import { ecosystemByKey, getGenerationSupport } from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { splitResourcesByType } from '~/shared/utils/resource.utils';
import { useGenerationGraphStore, generationGraphStore } from '~/store/generation-graph.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';

import { ResourceDataProvider, useResourceDataContext } from './inputs/ResourceDataProvider';
import { WhatIfProvider } from './WhatIfProvider';
import { needsHydration, type PartialResourceValue } from './inputs/resource-select.utils';

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
    {
      keys: [
        'workflow',
        'outputFormat',
        'priority',
        'prompt',
        'negativePrompt',
        'seed',
        'quantity',
      ],
    },
    { name: 'output', keys: ['ecosystem'], scope: 'output' },
    // ecosystem is scoped to workflow (different workflows may use different ecosystems)
    // { name: 'workflow', keys: ['ecosystem'], scope: 'workflow' },
    {
      name: 'workflow',
      keys: ['quantity'],
      scope: 'workflow',
      condition: (ctx) => ctx.workflow === 'txt2img:draft',
    },
    // Model-family specific settings scoped to ecosystem
    // Values for inactive nodes are automatically retained in storage
    // (e.g., cfgScale/steps when switching to Ultra mode which doesn't have them)
    { name: 'ecosystem', keys: '*', scope: 'ecosystem' },
    // Fallback for non-ecosystem workflows (upscale, interpolate, etc.)
    // These workflows don't have ecosystem, so the above group is skipped
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
  const { registerResourceId, unregisterResourceId } = useResourceDataContext();

  // Build external context from generation status
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
    }),
    [status.limits.quantity, status.limits.resources, status.tier]
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

  // Sync generation graph store data into the graph
  // - Remix/Replay: full override (reset + set)
  // - Run/Patch: partial update (set only)
  const prevCounterRef = useRef(0);
  useEffect(() => {
    function applyStoreData() {
      const { data, counter } = useGenerationGraphStore.getState();
      if (!data || counter === prevCounterRef.current) return;
      prevCounterRef.current = counter;

      // Params are already mapped via mapDataToGraphInput (workflow, ecosystem, aspectRatio, etc.)
      // Just need to split flat resources into model/resources/vae for graph nodes
      const split = splitResourcesByType(data.resources);

      if (data.runType === 'remix' || data.runType === 'replay') {
        // Full override: reset graph (excluding output settings), then apply all values
        // Exclude output settings from reset to preserve user's current preferences
        graph.reset({ exclude: ['quantity', 'priority', 'outputFormat'] });

        // Exclude output settings from remixed params so they don't override current values
        const { quantity, priority, outputFormat, ...paramsWithoutOutputSettings } = data.params;
        const values = {
          ...paramsWithoutOutputSettings,
          model: split.model,
          resources: split.resources,
          vae: split.vae,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose superset of discriminated union
        graph.set(values as any);
      } else {
        // Run/Patch: model/vae overwrite, resources merge with existing
        const snapshot = graph.getSnapshot() as Record<string, unknown>;
        const existingResources = (snapshot.resources ?? []) as ResourceData[];
        const incomingIds = new Set(split.resources.map((r) => r.id));

        // Determine incoming ecosystem for compatibility filtering
        const incomingEcosystem = data.params.ecosystem as string | undefined;
        const checkpointEcosystem = incomingEcosystem
          ? ecosystemByKey.get(incomingEcosystem)
          : undefined;

        // Filter existing resources: keep only those compatible with the incoming ecosystem
        const compatibleExisting = existingResources.filter((r) => {
          // Skip resources that are being replaced by incoming ones
          if (incomingIds.has(r.id)) return false;
          // If no checkpoint ecosystem to check against, keep the resource
          if (!checkpointEcosystem || !r.baseModel) return true;
          const resourceEcosystem = ecosystemByKey.get(r.baseModel);
          if (!resourceEcosystem) return true;
          const support = getGenerationSupport(
            checkpointEcosystem.id,
            resourceEcosystem.id,
            r.model.type as ModelType
          );
          return support !== null;
        });

        const mergedResources = [...compatibleExisting, ...split.resources];

        const values = {
          ...data.params,
          model: split.model,
          resources: mergedResources,
          vae: split.vae,
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose superset of discriminated union
        graph.set(values as any);
      }

      generationGraphStore.clearData();
    }

    // Check on mount (data may arrive before component mounts)
    applyStoreData();

    // Subscribe to future changes
    return useGenerationGraphStore.subscribe(applyStoreData);
  }, [graph]);

  // Register resource IDs from graph for hydration
  // This extracts IDs from model/resources/vae nodes and registers them with ResourceDataProvider.
  // Components can then access full resource data via getResourceData(id) without managing hydration.
  const registeredIdsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    function syncResourceIds() {
      const snapshot = graph.getSnapshot() as Record<string, unknown>;

      // Extract resource values from known resource nodes
      const resourceValues: PartialResourceValue[] = [];
      if (snapshot.model) resourceValues.push(snapshot.model as PartialResourceValue);
      if (snapshot.vae) resourceValues.push(snapshot.vae as PartialResourceValue);
      if (Array.isArray(snapshot.resources)) {
        resourceValues.push(...(snapshot.resources as PartialResourceValue[]));
      }

      // Find IDs that need hydration (missing full data)
      const idsToRegister = new Set(
        resourceValues.filter((v) => v?.id && needsHydration(v)).map((v) => v.id)
      );

      // Unregister IDs that are no longer needed
      for (const id of registeredIdsRef.current) {
        if (!idsToRegister.has(id)) {
          unregisterResourceId(id);
          registeredIdsRef.current.delete(id);
        }
      }

      // Register new IDs
      for (const id of idsToRegister) {
        if (!registeredIdsRef.current.has(id)) {
          registerResourceId(id);
          registeredIdsRef.current.add(id);
        }
      }
    }

    // Initial sync
    syncResourceIds();

    // Subscribe to graph changes
    return graph.subscribe(syncResourceIds);
  }, [graph, registerResourceId, unregisterResourceId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      for (const id of registeredIdsRef.current) {
        unregisterResourceId(id);
      }
      registeredIdsRef.current.clear();
    };
  }, [unregisterResourceId]);

  // Track preferred ecosystem when baseModel changes
  // This keeps the workflow preferences store in sync with what the user is actually using
  useEffect(() => {
    function syncPreferredEcosystem() {
      const snapshot = graph.getSnapshot() as Record<string, unknown>;
      const baseModel = snapshot.baseModel as string | undefined;
      const workflow = snapshot.workflow as string | undefined;
      if (!baseModel || !workflow) return;

      // Update the preferred ecosystem for this specific workflow
      workflowPreferences.setPreferredEcosystem(workflow, baseModel);
    }

    // Subscribe to graph changes
    return graph.subscribe(syncPreferredEcosystem);
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
