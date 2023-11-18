import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';

export function GenerationSidebar() {
  return (
    <ResizableSidebar resizePosition="right" minWidth={300} maxWidth={500} defaultWidth={400}>
      <GenerationTabs />
    </ResizableSidebar>
  );
}
