/**
 * form-graph generation form demo page. The BaseGenerationForm owns a store
 * over the ported composed root (`generationHub`) and switches between the
 * image and video forms on the graph's own `output` computed.
 * Access at: /form-graph
 */

import { Container } from '@mantine/core';

import { IsClient } from '~/components/IsClient/IsClient';
import { NotFound } from '~/components/AppLayout/NotFound';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { ResourceDataProvider } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { BaseGenerationForm } from '~/components/form-graph/generation/BaseGenerationForm';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export default function FormGraphDemoPage() {
  const features = useFeatureFlags();
  if (!features.formGraphGenerator) return <NotFound />;
  return (
    <Container size="xs" className="h-screen max-h-screen w-full overflow-y-auto px-0 py-3">
      <IsClient>
        {/* the resource-select components the bespoke slots will host read this
            context — mounted here the way GenerationTabs mounts it for v1 */}
        {/* queue state + rate limiting for the footer, same as GenerationTabs */}
        <GenerationProvider>
          <ResourceDataProvider>
            <BaseGenerationForm />
          </ResourceDataProvider>
        </GenerationProvider>
      </IsClient>
    </Container>
  );
}

FormGraphDemoPage.standalone = true;
