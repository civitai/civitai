/**
 * Generation V2 Index
 *
 * Exports a drop-in replacement for GenerationForm that can be used
 * in GenerationTabs.tsx without any changes to the parent component.
 */

import { LoadingOverlay } from '@mantine/core';

import { useIsClient } from '~/providers/IsClientProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useGenerationStore } from '~/store/generation.store';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';

import { GenerationForm } from './GenerationForm';
import { GenerationFormProvider } from './GenerationFormProvider';
import { type GenerationCtx } from '~/shared/data-graph/generation';

// =============================================================================
// Types
// =============================================================================

export interface GenerationFormV2Props {
  /** External context to pass to the graph */
  externalContext?: GenerationCtx;
  /** Enable debug mode for the graph */
  debug?: boolean;
}

// =============================================================================
// Default Context
// =============================================================================

const defaultExternalContext: GenerationCtx = {
  limits: {
    maxQuantity: 12,
    maxResources: 12,
  },
  user: {
    isMember: true,
    tier: 'gold',
  },
};

// =============================================================================
// Drop-in Replacement Component
// =============================================================================

/**
 * GenerationFormV2
 *
 * A drop-in replacement for the old GenerationForm that uses the new
 * DataGraph-based form system. Can be used directly in GenerationTabs.tsx.
 *
 * Usage in GenerationTabs.tsx:
 * ```tsx
 * import { GenerationFormV2 } from '~/components/generation_v2';
 *
 * const tabs: Tabs = {
 *   generate: {
 *     Icon: IconBrush,
 *     label: 'Generate',
 *     Component: GenerationFormV2,
 *   },
 *   // ...
 * };
 * ```
 */
export function GenerationFormV2({
  externalContext = defaultExternalContext,
  debug = false,
}: GenerationFormV2Props = {}) {
  const loading = useGenerationStore((state) => state.loading);
  const isClient = useIsClient();

  if (!isClient) return null;

  return (
    <GenerationProvider>
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <LoadingOverlay visible={loading} />
        <ScrollArea
          scrollRestore={{ key: 'generation-form-v2' }}
          pt={0}
          className="flex flex-col gap-2"
        >
          <GenerationFormProvider externalContext={externalContext} debug={debug}>
            <GenerationForm />
          </GenerationFormProvider>
        </ScrollArea>
      </div>
    </GenerationProvider>
  );
}

// Re-export individual components for direct use
export { GenerationForm } from './GenerationForm';
export { GenerationFormProvider } from './GenerationFormProvider';
export { FormFooter } from './FormFooter';
export { AccordionLayout } from './AccordionLayout';
export { openCompatibilityConfirmModal } from './CompatibilityConfirmModal';
