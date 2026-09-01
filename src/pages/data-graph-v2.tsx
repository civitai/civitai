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

// =============================================================================
// Main Demo Component
// =============================================================================

function DataGraphV2Demo() {
  return (
    // 🔴 `min-h-0 flex-1`, not `h-screen max-h-screen`. `standalone` pages are
    // rendered directly into `#__next`, which is a `height: 100%` flex column
    // that now carries `padding-top: var(--safe-area-inset-top)` — so its
    // CONTENT box is the cover viewport minus the top inset, while `h-screen`
    // still measures the whole cover viewport. Combined with `overflow-hidden`
    // on this very element, the excess is CLIPPED rather than scrolled: the
    // bottom of the generation form becomes unreachable on a notched phone.
    // Sizing to the slot is the same remedy `images/iterate.tsx` uses, and it
    // is exact on every device rather than approximately right on one.
    <Container size="xs" className="min-h-0 w-full flex-1 overflow-hidden px-0 py-3">
      <IsClient>
        <GenerationFormProvider debug>
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
