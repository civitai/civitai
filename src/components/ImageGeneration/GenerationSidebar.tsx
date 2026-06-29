import { useWindowEvent } from '@mantine/hooks';
import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';
import { useResizeStore } from '~/components/Resizable/useResize';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
const GenerationTabs = dynamic(() => import('~/components/ImageGeneration/GenerationTabs'));

const RESIZE_STORE_NAME = 'generation-sidebar';
const DEFAULT_WIDTH = 400;

export function GenerationSidebar() {
  const _opened = useGenerationPanelStore((state) => state.opened);
  const router = useRouter();
  // TODO - see if we can elevate this to `BaseLayout` and set visibility hidden to content behind sidebar
  const [fullScreen, setFullScreen] = useState(false);
  const isGeneratePage = router.pathname.startsWith('/generate');
  const opened = _opened || isGeneratePage;

  const updateShowDrawer = useCallback(() => {
    const width = useResizeStore.getState()[RESIZE_STORE_NAME] ?? DEFAULT_WIDTH;
    setFullScreen(width + 320 > window.innerWidth);
  }, []);

  useEffect(() => {
    if (isGeneratePage) useGenerationPanelStore.setState({ opened: true });
  }, [isGeneratePage]);

  useEffect(() => {
    if (opened) {
      updateShowDrawer();
      useResizeStore.subscribe((state) => {
        const width = state[RESIZE_STORE_NAME] ?? DEFAULT_WIDTH;
        setFullScreen(width + 320 > window.innerWidth);
      });
    }
  }, [opened, updateShowDrawer]);

  useWindowEvent('resize', updateShowDrawer);

  if (!opened) return null;

  return (
    <ResizableSidebar
      name={RESIZE_STORE_NAME}
      data-tour="gen:start"
      resizePosition="right"
      minWidth={350}
      maxWidth={800}
      defaultWidth={DEFAULT_WIDTH}
      className={clsx('z-10', fullScreen && 'z-[210] !w-screen')}
    >
      <div className="size-full">
        <ContainerProvider containerName={RESIZE_STORE_NAME} className="bg-gray-0 dark:bg-dark-7">
          <GenerationTabs fullScreen={fullScreen} />
        </ContainerProvider>
      </div>
    </ResizableSidebar>
  );
}
