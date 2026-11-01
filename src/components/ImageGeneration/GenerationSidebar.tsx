import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import {
  GENERATION_SIDEBAR_DEFAULT_WIDTH,
  GENERATION_SIDEBAR_NAME,
  useGenerationPanelFullScreen,
} from '~/components/ImageGeneration/useGenerationPanelFullScreen';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';
import { useRefreshResidencyOnOpen } from '~/components/ResourceLoad/ResourceResidency';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
const GenerationPanel = dynamic(() => import('~/components/ImageGeneration/GenerationTabs'));

export function useGenerationSidebarState() {
  const _opened = useGenerationPanelStore((state) => state.opened);
  const router = useRouter();
  const fullScreen = useGenerationPanelFullScreen() ?? false;
  // `/generate` renders the generator itself; a second copy here doubles every query and image.
  const opened = _opened && !router.pathname.startsWith('/generate');
  return { opened, fullScreen, coversPage: opened && fullScreen };
}

export function GenerationSidebar() {
  const router = useRouter();
  const { opened, fullScreen } = useGenerationSidebarState();

  useRefreshResidencyOnOpen(opened);

  if (!opened) return null;

  return (
    <GenerationColumn className={clsx('z-10', fullScreen && 'z-[210] !w-screen')}>
      <GenerationPanel
        onClose={generationGraphPanel.close}
        closeLabel="Close generation panel"
        onMaximize={fullScreen ? undefined : () => router.push('/generate')}
      />
    </GenerationColumn>
  );
}

export function GenerationColumn({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <ResizableSidebar
      name={GENERATION_SIDEBAR_NAME}
      resizePosition="right"
      minWidth={350}
      maxWidth={800}
      defaultWidth={GENERATION_SIDEBAR_DEFAULT_WIDTH}
      className={className}
    >
      <GenerationSurface>{children}</GenerationSurface>
    </ResizableSidebar>
  );
}

/** What the generator renders into, whether it is a column or the whole viewport. */
export function GenerationSurface({ children }: { children: ReactNode }) {
  return (
    <div data-tour="gen:start" className="size-full">
      <ContainerProvider
        containerName={GENERATION_SIDEBAR_NAME}
        className="bg-gray-0 dark:bg-dark-7"
      >
        {children}
      </ContainerProvider>
    </div>
  );
}
