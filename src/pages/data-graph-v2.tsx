/**
 * DataGraph V2 Demo Page
 *
 * Demonstrates the DataGraph with Controller pattern for explicit form control.
 * This is feature-parity with data-graph-standalone.tsx but uses Controller instead of RenderNodes.
 * Access at: /data-graph-v2
 *
 * Key difference from RenderNodes approach:
 * - Static props (label, buttonLabel, placeholder, etc.) are defined inline in the component
 * - Only dynamic props (options, min/max from context, etc.) come from meta
 */

import { Container } from '@mantine/core';

import { IsClient } from '~/components/IsClient/IsClient';
import { GenerationForm } from '~/components/generation_v2/GenerationForm';
import { GenerationFormProvider } from '~/components/generation_v2/GenerationFormProvider';
import { type GenerationCtx } from '~/shared/data-graph/generation';

// =============================================================================
// Main Demo Component
// =============================================================================

function DataGraphV2Demo() {
  const externalContext: GenerationCtx = {
    limits: {
      maxQuantity: 12,
      maxResources: 12,
    },
    user: {
      isMember: true,
      tier: 'gold',
    },
  };

  return (
    <Container size="xs" className="h-screen max-h-screen w-full overflow-hidden px-0 py-3">
      <IsClient>
        <GenerationFormProvider externalContext={externalContext} debug>
          <GenerationForm />
        </GenerationFormProvider>
      </IsClient>
    </Container>
  );
}

// =============================================================================
// Page Export
// =============================================================================

export default function DataGraphV2Page() {
  return <DataGraphV2Demo />;
}

DataGraphV2Page.standalone = true;
