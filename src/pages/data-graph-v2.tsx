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
import { GenerationFormV2 } from '~/components/generation_v2';
import { ResourceDataProvider } from '~/components/generation_v2/inputs/ResourceDataProvider';

// =============================================================================
// Main Demo Component
// =============================================================================

function DataGraphV2Demo() {
  return (
    // 🔴 `min-h-0 flex-1`, not `h-screen max-h-screen`. A `standalone` page
    // skips `AppLayout` but NOT the shell above it — the chain, verified rather
    // than assumed, is:
    //
    //   #__next                       flex column, height:100%, and now
    //                                 `padding-top: var(--safe-area-inset-top)`
    //     └ BaseLayout   `flex flex-1 overflow-hidden`          (a flex ROW)
    //         └ ContainerProvider#main  `flex h-full flex-col flex-1`
    //             └ this <Container>
    //
    // So this element's slot is `#__next`'s CONTENT box — the cover viewport
    // minus the top inset — while `h-screen` still measures the whole cover
    // viewport. With `overflow-hidden` both here and on the BaseLayout row, the
    // excess is CLIPPED rather than scrolled: the bottom of the generation form
    // becomes unreachable on a notched phone. `flex-1` takes the slot instead
    // of re-deriving it, which is exact on every device rather than
    // approximately right on one — the same remedy `images/iterate.tsx` uses.
    // (`min-h-0` is required with it: a flex item's default `min-height: auto`
    // refuses to shrink below its content and would reinstate the overflow.)
    <Container size="xs" className="min-h-0 w-full flex-1 overflow-hidden px-0 py-3">
      <IsClient>
        {/* GenerationFormV2 packages GenerationProvider + GenerationFormProvider
            + GenerationForm; ResourceDataProvider is the one context the shell
            (GenerationTabs) mounts ABOVE that package, so the standalone demo
            must mount it too */}
        <ResourceDataProvider>
          <GenerationFormV2 debug />
        </ResourceDataProvider>
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
