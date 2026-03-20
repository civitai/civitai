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
  baseModelByName,
  ecosystemByKey,
  ecosystemById,
  getEcosystem,
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

import {
  openCompatibilityConfirmModal,
  buildWorkflowPendingChange,
} from './CompatibilityConfirmModal';
import { useResourceDataContext } from './inputs/ResourceDataProvider';
import { WhatIfProvider } from './WhatIfProvider';
import { needsHydration, type PartialResourceValue } from './inputs/resource-select.utils';
import type { GenerationResource } from '~/shared/types/generation.types';
import { type VersionGroup, getAllVersionIds } from '~/shared/data-graph/generation/common';

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

  // On mount: detect if the stored workflow/ecosystem was auto-corrected during init
  // (e.g., workflow or ecosystem was removed/disabled). Show compatibility modal so the user
  // can pick a valid ecosystem instead of being silently switched.
  useEffect(() => {
    try {
      // Read the raw stored workflow from localStorage (before graph corrections)
      const globalStored = localStorage.getItem(STORAGE_KEY);
      if (!globalStored) return;
      const globalValues = JSON.parse(globalStored) as Record<string, unknown>;
      const storedWorkflow = globalValues.workflow as string | undefined;
      if (!storedWorkflow) return;

      // Determine the output type from the stored workflow key prefix
      // (can't use getOutputTypeForWorkflow — it falls back to 'image' for unknown workflows)
      const storedOutputType = storedWorkflow.includes('2vid') ? 'video' : 'image';

      // Read the stored ecosystem from the output-scoped storage
      const outputStored = localStorage.getItem(`${STORAGE_KEY}.output.${storedOutputType}`);
      if (!outputStored) return;
      const outputValues = JSON.parse(outputStored) as Record<string, unknown>;
      const storedEcosystem = outputValues.ecosystem as string | undefined;
      if (!storedEcosystem) return;

      // Resolve what the graph corrected to
      const snapshot = graph.getSnapshot() as Record<string, unknown>;
      const resolvedEcosystem = snapshot.ecosystem as string | undefined;

      // If the stored ecosystem matches the resolved one, no correction happened
      if (storedEcosystem === resolvedEcosystem) return;

      // Determine the target workflow — use stored if known, else derive from prefix
      const resolvedWorkflow = workflowConfigByKey.has(storedWorkflow)
        ? storedWorkflow
        : storedOutputType === 'video'
        ? 'txt2vid'
        : 'txt2img';

      // Verify the stored ecosystem is actually incompatible (not just an internal re-org)
      const storedEco = ecosystemByKey.get(storedEcosystem);
      if (storedEco && isWorkflowAvailable(resolvedWorkflow, storedEco.id)) return;

      // Ecosystem was corrected — show compatibility modal
      openCompatibilityConfirmModal({
        pendingChange: buildWorkflowPendingChange({
          workflowId: resolvedWorkflow,
          currentEcosystem: storedEcosystem,
        }),
        onConfirm: (selectedEcosystemKey) => {
          if (selectedEcosystemKey) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            graph.set({ workflow: resolvedWorkflow, ecosystem: selectedEcosystemKey } as any);
          }
        },
      });
    } catch {
      // localStorage read failed, skip
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
          // Workflow unknown — infer output type from the workflow key prefix or ecosystem
          const isVideoWorkflow =
            resolvedWorkflow?.includes('2vid') || resolvedWorkflow?.startsWith('vid2');
          const remixEcoEntry = remixEcosystemKey
            ? ecosystemByKey.get(remixEcosystemKey)
            : undefined;
          const isVideoEco =
            remixEcoEntry &&
            getBaseModelsByEcosystemId(remixEcoEntry.id).some((m) =>
              Array.isArray(m.type) ? m.type.includes('video') : m.type === 'video'
            );
          resolvedWorkflow = isVideoWorkflow || isVideoEco ? 'txt2vid' : 'txt2img';
        }

        // Check if the remix ecosystem supports the resolved workflow
        const remixEco = remixEcosystemKey ? ecosystemByKey.get(remixEcosystemKey) : undefined;
        const ecosystemSupportsWorkflow = remixEco
          ? isWorkflowAvailable(resolvedWorkflow, remixEco.id)
          : !remixEcosystemKey; // Unknown ecosystem key — treat as incompatible

        // Build the values to apply (shared between both paths)
        const remixValues = {
          ...paramsWithoutOutputSettings,
          workflow: resolvedWorkflow,
          model: split.model,
          resources: split.resources,
          vae: split.vae,
        };

        if (!ecosystemSupportsWorkflow && remixEcosystemKey) {
          // Ecosystem doesn't support this workflow — show modal before applying
          openCompatibilityConfirmModal({
            pendingChange: buildWorkflowPendingChange({
              workflowId: resolvedWorkflow,
              currentEcosystem: remixEcosystemKey,
            }),
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
      } else if (data.runType === 'append') {
        // Append: merge incoming images with existing, dedup by URL, cap at max
        const snapshot = graph.getSnapshot() as Record<string, unknown>;
        let existingImages: Array<{ url: string }> = [];
        if (snapshot.workflow === data.params.workflow) {
          // Same workflow — use live snapshot images
          existingImages = ((snapshot.images ?? []) as Array<{ url: string }>) || [];
        } else {
          // Switching workflows — read persisted images for the target workflow from localStorage
          try {
            const stored = localStorage.getItem(`${STORAGE_KEY}.workflow.${data.params.workflow}`);
            if (stored) {
              const parsed = JSON.parse(stored);
              existingImages = (parsed.images as Array<{ url: string }>) || [];
            }
          } catch {
            // Invalid JSON, start fresh
          }
        }
        const incomingImages =
          ((data.params.images ?? []) as Array<{ url: string; width: number; height: number }>) ||
          [];

        // Deduplicate by URL
        const existingUrls = new Set(existingImages.map((img) => img.url));
        const newImages = incomingImages.filter((img) => !existingUrls.has(img.url));
        const mergedImages = [...existingImages, ...newImages];

        // Set workflow (in case we're switching to upscale) and merged images
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        graph.set({ workflow: data.params.workflow, images: mergedImages } as any);
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

        // If current workflow doesn't support ecosystems (e.g. img2meta),
        // switch to the user's last used workflow that supports the resource's ecosystem
        const currentWorkflow = snapshot.workflow as string | undefined;
        const currentWorkflowConfig = currentWorkflow
          ? workflowConfigByKey.get(currentWorkflow)
          : undefined;
        let targetWorkflow = data.params.workflow as string | undefined;
        if (
          !targetWorkflow &&
          currentWorkflowConfig &&
          currentWorkflowConfig.ecosystemIds.length === 0
        ) {
          // Determine the resource's ecosystem from the checkpoint (or first resource with baseModel)
          const resourceWithBaseModel =
            split.resources.find((r) => r.model.type === 'Checkpoint') ??
            split.resources.find((r) => r.baseModel);
          const resourceEcosystem = resourceWithBaseModel?.baseModel
            ? getEcosystem(resourceWithBaseModel.baseModel)
            : undefined;

          if (resourceEcosystem) {
            const lastUsed = workflowPreferences.getLastUsedWorkflowForEcosystem(
              resourceEcosystem.id
            );
            targetWorkflow = lastUsed?.workflow ?? 'txt2img';
          } else {
            const lastUsed = workflowPreferences.getLastUsedWorkflow();
            targetWorkflow = lastUsed?.workflow ?? 'txt2img';
          }
        }

        // If all incoming resources have full or partial compatibility with the
        // current ecosystem, preserve it. Only switch ecosystem when a resource
        // is incompatible (no compatibility).
        const currentEcosystem = snapshot.ecosystem as string | undefined;
        const currentEco = currentEcosystem ? ecosystemByKey.get(currentEcosystem) : undefined;
        const allCompatible =
          currentEco &&
          data.resources.length > 0 &&
          data.resources.every((r) => {
            if (!r.baseModel) return true;
            const resourceBaseModel = baseModelByName.get(r.baseModel);
            if (!resourceBaseModel) return true;
            return (
              getGenerationSupport(
                currentEco.id,
                resourceBaseModel.ecosystemId,
                r.model.type as ModelType
              ) !== null
            );
          });

        const { ecosystem: _incomingEco, ...paramsWithoutEcosystem } = data.params;
        const values = {
          ...(allCompatible ? paramsWithoutEcosystem : data.params),
          ...(targetWorkflow && { workflow: targetWorkflow }),
          resources: mergedResources,
          // Only include model/vae when present — otherwise we'd nullify the current value
          ...(split.model && { model: split.model }),
          ...(split.vae && { vae: split.vae }),
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

  // Enforce version constraints when workflow changes.
  // If the current model is excluded by the workflow's config (excludeModelVersionIds),
  // force-switch to the first valid version. This handles ALL entry points (form, store,
  // modal, generated-item menu) since it reacts to graph state, not the source of change.
  useEffect(() => {
    let prevWorkflow: string | undefined;
    return graph.subscribe(() => {
      const snapshot = graph.getSnapshot() as Record<string, unknown>;
      const workflow = snapshot.workflow as string | undefined;
      if (!workflow || workflow === prevWorkflow) return;
      prevWorkflow = workflow;

      const config = workflowConfigByKey.get(workflow);
      if (!config?.excludeModelVersionIds?.length) return;

      const currentModelId = (snapshot.model as { id?: number } | undefined)?.id;
      if (!currentModelId || !config.excludeModelVersionIds.includes(currentModelId)) return;

      // Current model is excluded — read version options from model meta and pick first valid one
      const modelMeta = graph.getNodeMeta('model' as never) as
        | { versions?: VersionGroup }
        | undefined;
      if (!modelMeta?.versions) return;

      const allIds = getAllVersionIds(modelMeta.versions);
      const validId = [...allIds].find((id) => !config.excludeModelVersionIds!.includes(id));
      if (validId) {
        // Defer to avoid re-entrant graph.set during notification callback.
        // queueMicrotask runs before the next paint, so React batches both updates.
        queueMicrotask(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          graph.set({ model: { id: validId, model: { type: 'Checkpoint' } } } as any);
        });
      }
    });
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
