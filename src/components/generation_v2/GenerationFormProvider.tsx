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
import {
  allEcosystemDefaultVersionIds,
  ecosystemByKey,
  ecosystemById,
  getGenerationSupport,
  getBaseModelsByEcosystemId,
  ecosystemGroups,
  getEcosystemGroup,
} from '~/shared/constants/basemodel.constants';
import {
  workflowConfigByKey,
  isWorkflowAvailable,
  getEcosystemsForWorkflow,
  getOutputTypeForWorkflow,
} from '~/shared/data-graph/generation/config/workflows';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { splitResourcesByType } from '~/shared/utils/resource.utils';
import { useGenerationGraphStore, generationGraphStore } from '~/store/generation-graph.store';
import { workflowPreferences } from '~/store/workflow-preferences.store';

import { openCompatibilityConfirmModal } from './CompatibilityConfirmModal';
import { useResourceDataContext } from './inputs/ResourceDataProvider';
import { WhatIfProvider } from './WhatIfProvider';
import { needsHydration, type PartialResourceValue } from './inputs/resource-select.utils';
import type { GenerationResource } from '~/shared/types/generation.types';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY = 'generation-graph';

// =============================================================================
// Storage Utilities
// =============================================================================

/**
 * Clear all localStorage entries for workflows of a given output type.
 * Removes global settings (prompt, seed, etc.), output-scoped ecosystem,
 * workflow-scoped settings, and ecosystem-scoped settings for all
 * ecosystems used by workflows of that output type.
 */
export function clearStorageForOutput(outputType: 'image' | 'video') {
  // Global key (prompt, seed, quantity, outputFormat, etc.)
  localStorage.removeItem(STORAGE_KEY);

  // Output-scoped ecosystem
  localStorage.removeItem(`${STORAGE_KEY}.output.${outputType}`);

  // Collect all ecosystem IDs used by workflows of this output type
  const ecosystemIds = new Set<number>();

  // Workflow-scoped keys
  for (const [key] of workflowConfigByKey) {
    if (getOutputTypeForWorkflow(key) === outputType) {
      localStorage.removeItem(`${STORAGE_KEY}.workflow.${key}`);
      for (const ecoId of getEcosystemsForWorkflow(key)) {
        ecosystemIds.add(ecoId);
      }
    }
  }

  // Ecosystem-scoped keys (individual + group)
  const clearedGroups = new Set<string>();
  for (const ecoId of ecosystemIds) {
    const eco = ecosystemById.get(ecoId);
    if (!eco) continue;

    // Individual ecosystem key
    localStorage.removeItem(`${STORAGE_KEY}.ecosystem.${eco.key}`);

    // Ecosystem group key (shared settings across group variants)
    const group = getEcosystemGroup(ecoId);
    if (group && !clearedGroups.has(group.id)) {
      localStorage.removeItem(`${STORAGE_KEY}.ecosystem.${group.id}`);
      clearedGroups.add(group.id);
    }
  }
}

/**
 * Returns all model version IDs to prefetch for the compatibility modal:
 * ecosystem defaults + last-used checkpoints for every ecosystem in localStorage.
 *
 * Both GenerationTabs (prefetch) and the modal use this function so their
 * query keys always match, guaranteeing an instant cache hit when the modal opens.
 */
export function getAllEcosystemVersionIdsForPrefetch(): number[] {
  const ids = new Set(allEcosystemDefaultVersionIds);
  for (const [key] of ecosystemByKey) {
    const lastUsedId = getLastUsedCheckpointIdForEcosystem(key);
    if (lastUsedId) ids.add(lastUsedId);
  }
  return [...ids];
}

/**
 * Returns the last-used model version ID for a given ecosystem key.
 * Reads from the ecosystem-scoped localStorage entry written by the storage adapter.
 * Returns undefined if no previous selection exists.
 */
export function getLastUsedCheckpointIdForEcosystem(ecosystemKey: string): number | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const eco = ecosystemByKey.get(ecosystemKey);
  if (!eco) return undefined;

  const group = getEcosystemGroup(eco.id);
  const scopeKey = group ? group.id : eco.key;

  try {
    const stored = localStorage.getItem(`${STORAGE_KEY}.ecosystem.${scopeKey}`);
    if (!stored) return undefined;
    const values = JSON.parse(stored) as Record<string, unknown>;
    const modelId = (values?.model as { id?: unknown } | undefined)?.id;
    return typeof modelId === 'number' ? modelId : undefined;
  } catch {
    return undefined;
  }
}

// =============================================================================
// Storage Adapter
// =============================================================================

const storageAdapter = createLocalStorageAdapter({
  prefix: STORAGE_KEY,
  groups: [
    // User preferences - persisted across resets
    { name: 'preferences', keys: ['outputFormat', 'priority'] },
    // Workflow is the primary selector - stored globally
    {
      keys: ['workflow', 'prompt', 'negativePrompt', 'seed', 'quantity'],
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
    { name: 'workflow', keys: ['images', 'video'], scope: 'workflow' },
    // Ecosystem groups - settings scoped by group ID for grouped ecosystems
    // This allows settings to persist when switching between variants (e.g., Wan 2.5 <-> Wan 2.2)
    ...ecosystemGroups.map((group) => ({
      name: 'ecosystem',
      keys: '*' as const,
      scope: group.id,
      condition: (ctx: Record<string, unknown>) => {
        const ecoKey = ctx.ecosystem as string | undefined;
        if (!ecoKey) return false;
        const eco = ecosystemByKey.get(ecoKey);
        if (!eco) return false;
        return group.ecosystemIds.includes(eco.id);
      },
    })),
    // Model-family specific settings scoped to individual ecosystem (for standalone ecosystems)
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
      const split = splitResourcesByType(data.resources.map(toResourceData));

      if (data.runType === 'remix' || data.runType === 'replay') {
        // Exclude output settings from remixed params so they don't override current values
        const { quantity, priority, outputFormat, ...paramsWithoutOutputSettings } = data.params;

        // Resolve workflow — if missing or unrecognized, derive from ecosystem's base model type
        const remixEcosystemKey = paramsWithoutOutputSettings.ecosystem as string | undefined;
        let resolvedWorkflow = paramsWithoutOutputSettings.workflow as string | undefined;
        if (!resolvedWorkflow || !workflowConfigByKey.has(resolvedWorkflow)) {
          // Workflow unknown — check the ecosystem's base model type to pick the right default
          const remixEcoEntry = remixEcosystemKey
            ? ecosystemByKey.get(remixEcosystemKey)
            : undefined;
          const isVideoEco =
            remixEcoEntry &&
            getBaseModelsByEcosystemId(remixEcoEntry.id).some((m) => m.type === 'video');
          resolvedWorkflow = isVideoEco ? 'txt2vid' : 'txt2img';
        }

        // Check if the remix ecosystem supports the resolved workflow
        const remixEco = remixEcosystemKey ? ecosystemByKey.get(remixEcosystemKey) : undefined;
        const ecosystemSupportsWorkflow = remixEco
          ? isWorkflowAvailable(resolvedWorkflow, remixEco.id)
          : true;

        // Build the values to apply (shared between both paths)
        const remixValues = {
          ...paramsWithoutOutputSettings,
          workflow: resolvedWorkflow,
          model: split.model,
          resources: split.resources,
          vae: split.vae,
        };

        if (!ecosystemSupportsWorkflow && remixEco) {
          // Ecosystem doesn't support this workflow — show modal before applying
          const compatibleIds = getEcosystemsForWorkflow(resolvedWorkflow);
          const defaultEcoId = compatibleIds[0];
          const defaultEco = defaultEcoId ? ecosystemById.get(defaultEcoId) : undefined;

          openCompatibilityConfirmModal({
            pendingChange: {
              type: 'workflow',
              value: resolvedWorkflow,
              optionId: resolvedWorkflow,
              currentEcosystem: remixEcosystemKey!,
              compatibleEcosystemIds: compatibleIds,
              defaultEcosystemKey: defaultEco?.key ?? '',
            },
            onConfirm: (selectedEcosystemKey) => {
              if (selectedEcosystemKey) {
                graph.reset({ exclude: ['quantity', 'priority', 'outputFormat'] });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                graph.set({ ...remixValues, ecosystem: selectedEcosystemKey } as any);
              }
            },
          });
        } else {
          // Compatible — apply immediately
          graph.reset({ exclude: ['quantity', 'priority', 'outputFormat'] });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose superset of discriminated union
          graph.set(remixValues as any);
        }
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
      const ecosystem = snapshot.ecosystem as string | undefined;
      const workflow = snapshot.workflow as string | undefined;
      if (!ecosystem || !workflow) return;

      // Update the preferred ecosystem for this specific workflow
      workflowPreferences.setPreferredEcosystem(workflow, ecosystem);
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
    <InnerProvider defaultValues={defaultValues} debug={debug} skipStorage={skipStorage}>
      {children}
    </InnerProvider>
  );
}

/** Convert GenerationResource to ResourceData (matching data-graph resourceSchema) */
function toResourceData(r: GenerationResource): ResourceData {
  if (r.epochDetails) return r; // Shouldn't need to get fresh data for resources with epochDetails since they have all necessary info for compatibility checks (type, baseModel, epochNumber) and aren't selectable in the UI
  return {
    id: r.id,
    baseModel: r.baseModel,
    model: { type: r.model.type },
    strength: r.strength,
    trainedWords: r.trainedWords.length > 0 ? r.trainedWords : undefined,
  };
}
