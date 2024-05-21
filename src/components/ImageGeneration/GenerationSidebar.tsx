import { useWindowEvent } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GenerationDrawer } from '~/components/ImageGeneration/GenerationDrawer';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';
import { useResizeStore } from '~/components/Resizable/useResize';
import { generationPanel, useGenerationStore } from '~/store/generation.store';

export function GenerationSidebar() {
  const _opened = useGenerationStore((state) => state.opened);
  const router = useRouter();
  // TODO - see if we can elevate this to `BaseLayout` and set visibility hidden to content behind sidebar
  const [fullScreen, setFullScreen] = useState(false);
  const isGeneratePage = router.pathname.startsWith('/generate');
  const opened = _opened || isGeneratePage;

  const updateShowDrawer = useCallback(() => {
    const width = useResizeStore.getState()['generation-sidebar'];
    setFullScreen(width + 320 > window.innerWidth);
  }, []);

  useEffect(() => {
    if (opened) {
      updateShowDrawer();
      useResizeStore.subscribe((state) => {
        const width = state['generation-sidebar'] ?? 400;
        setFullScreen(width + 320 > window.innerWidth);
      });
    }
  }, [opened, updateShowDrawer]);

  useWindowEvent('resize', updateShowDrawer);

  // useEffect(() => {
  //   opened && showDrawer
  //     ? dialogStore.trigger({
  //         component: GenerationDrawer,
  //         id: 'generation-drawer',
  //         options: { onClose: generationPanel.close },
  //       })
  //     : dialogStore.closeById('generation-drawer');
  // }, [showDrawer, opened]);

  if (!opened) return null;

  return (
    <ResizableSidebar
      name="generation-sidebar"
      resizePosition="right"
      minWidth={350}
      maxWidth={800}
      defaultWidth={400}
      className={`z-10 ${fullScreen ? 'max-w-0' : ''}`}
    >
      <div className={`size-full ${fullScreen ? `fixed inset-0 w-screen` : ''}`}>
        <ContainerProvider containerName="generation-sidebar" className="bg-gray-0 dark:bg-dark-9">
          <GenerationTabs fullScreen={fullScreen} />
        </ContainerProvider>
      </div>
    </ResizableSidebar>
  );
}
