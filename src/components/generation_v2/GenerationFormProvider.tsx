/**
 * GenerationFormProvider
 *
 * Provider wrapper that sets up the DataGraph context for the generation form.
 * This includes the graph, storage adapter, and external context.
 */

import type { ReactNode } from 'react';

import { DataGraphProvider } from '~/libs/data-graph/react';
import { createLocalStorageAdapter } from '~/libs/data-graph/storage-adapter';
import { generationGraph, type GenerationCtx } from '~/shared/data-graph/generation';

import { ResourceDataProvider } from './inputs/ResourceDataProvider';

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
    // Common settings shared across all workflows
    // Model-family specific settings scoped to baseModel
    // Values for inactive nodes are automatically retained in storage
    // (e.g., cfgScale/steps when switching to Ultra mode which doesn't have them)
    { name: 'scoped', keys: '*', scope: 'baseModel' },
  ],
});

// =============================================================================
// Types
// =============================================================================

export interface GenerationFormProviderProps {
  children: ReactNode;
  /** Default/initial values to pass to graph.init() (e.g., from API data) */
  defaultValues?: Record<string, unknown>;
  /** External context to pass to the graph */
  externalContext?: GenerationCtx;
  /** Enable debug mode for the graph */
  debug?: boolean;
  /** Skip loading values from localStorage (use only defaultValues and node defaults) */
  skipStorage?: boolean;
}

// =============================================================================
// Default Context
// =============================================================================

const defaultExternalContext: GenerationCtx = {
  limits: {
    maxQuantity: 12,
    maxSteps: 50,
    maxResolution: 1280,
    maxResources: 12,
  },
  user: {
    isMember: true,
    tier: 'pro',
  },
  resources: [],
};

// =============================================================================
// Component
// =============================================================================

export function GenerationFormProvider({
  children,
  defaultValues,
  externalContext = defaultExternalContext,
  debug = false,
  skipStorage = false,
}: GenerationFormProviderProps) {
  return (
    <ResourceDataProvider>
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
    </ResourceDataProvider>
  );
}
