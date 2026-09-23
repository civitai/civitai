import { LoadingOverlay } from '@mantine/core';
import { useIsClient } from '~/providers/IsClientProvider';
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { Announcements } from '~/components/Announcements/Announcements';

import { BaseGenerationForm } from './BaseGenerationForm';

/**
 * The form-graph lane's counterpart of `GenerationFormV2` — the shell
 * GenerationTabs mounts when the `formGraphGenerator` flag is on. Same
 * provider stack (queue state, resource data, announcements, scroll
 * restore); only the form inside differs.
 */
export function FormGraphGenerator() {
  const isClient = useIsClient();
  const loading = useGenerationGraphStore((s) => s.loading);

  if (!isClient) return null;

  return (
    <GenerationProvider>
      <div className="relative flex flex-1 flex-col overflow-hidden">
        <LoadingOverlay visible={loading} />
        <ScrollArea
          scrollRestore={{ key: 'form-graph-generator' }}
          pt={0}
          className="flex flex-col gap-2"
        >
          <Announcements type="generator" />
          <BaseGenerationForm />
        </ScrollArea>
      </div>
    </GenerationProvider>
  );
}
