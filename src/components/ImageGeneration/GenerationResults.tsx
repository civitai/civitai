import { Feed } from '~/components/ImageGeneration/Feed';
import { GeneratedRequestsProvider } from '~/components/ImageGeneration/GeneratedRequestsProvider';
import { Queue } from '~/components/ImageGeneration/Queue';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import type { GenerationResultsView } from '~/store/generation-panel.store';

export function GenerationResults({ view }: { view: GenerationResultsView }) {
  return (
    <GeneratedRequestsProvider>
      <ScrollArea scrollRestore={{ key: view }}>
        {view === 'queue' ? <Queue /> : <Feed />}
      </ScrollArea>
    </GeneratedRequestsProvider>
  );
}
