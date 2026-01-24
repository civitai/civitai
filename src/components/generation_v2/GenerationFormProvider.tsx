/**
 * GenerationFormProvider
 *
 * Provider wrapper that sets up the DataGraph context for the generation form.
 * This includes the graph, storage adapter, and external context.
 */

import { useMemo, type ReactNode } from 'react';

import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { DataGraphProvider } from '~/libs/data-graph/react';
import { createLocalStorageAdapter } from '~/libs/data-graph/storage-adapter';
import { generationGraph, type GenerationCtx } from '~/shared/data-graph/generation';

import { ResourceDataProvider, useResourceDataContext } from './inputs/ResourceDataProvider';

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

  // Map resources to the expected format for GenerationCtx
  const mappedResources = useMemo(
    () =>
      resources.map((r) => ({
        id: r.id,
        baseModel: r.baseModel,
        modelType: r.model.type,
      })),
    [resources]
  );

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
      resources: mappedResources,
    }),
    [status.limits.quantity, status.limits.resources, status.tier, mappedResources]
  );

  return (
    <DataGraphProvider
      graph={generationGraph}
      storage={storageAdapter}
      defaultValues={defaultValues}
      externalContext={externalContext}
      debug={debug}
      skipStorage={skipStorage}
    >
      {children}
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
