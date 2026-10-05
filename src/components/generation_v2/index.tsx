/**
 * Generation V2 Index — the data-graph generation form lane.
 */

import { LoadingOverlay } from '@mantine/core';

import { useIsClient } from '~/providers/IsClientProvider';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { Announcements } from '~/components/Announcements/Announcements';

import { GenerationForm } from './GenerationForm';
import { GenerationFormProvider } from './GenerationFormProvider';

// =============================================================================
// Types
// =============================================================================

export interface GenerationFormV2Props {
  /** Enable debug mode for the graph */
  debug?: boolean;
}

// =============================================================================
// Drop-in Replacement Component
// =============================================================================

/**
 * The data-graph form lane. `GenerationTabs.tsx` mounts it in the form slot when
 * `formGraphGenerator` is off; `FormGraphGenerator` is the other lane.
 */
export function GenerationFormV2({ debug = false }: GenerationFormV2Props = {}) {
  const loading = useGenerationGraphStore((state) => state.loading);
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
          <Announcements type="generator" />
          <GenerationFormProvider debug={debug}>
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
export { WhatIfProvider, useWhatIfContext } from './WhatIfProvider';
export { ResourceAlerts, DownloadReadyAlert } from './ResourceAlerts';
export { ExperimentalFlask, GateRuleAlerts } from './Experimental';
