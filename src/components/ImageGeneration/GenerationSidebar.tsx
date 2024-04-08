import { Group, ActionIcon, CloseButton, Tooltip } from '@mantine/core';
import { useWindowEvent } from '@mantine/hooks';
import { IconArrowsDiagonal } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { FeatureIntroductionHelpButton } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GenerationDrawer } from '~/components/ImageGeneration/GenerationDrawer';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';
import { useResizeStore } from '~/components/Resizable/useResize';
import { generationPanel, useGenerationStore } from '~/store/generation.store';

export function GenerationSidebar() {
  const _opened = useGenerationStore((state) => state.opened);
  const router = useRouter();
  const [showDrawer, setShowDrawer] = useState(false);
  const isGeneratePage = router.pathname.startsWith('/generate');
  const opened = _opened || isGeneratePage;

  const updateShowDrawer = useCallback(() => {
    const width = useResizeStore.getState()['generation-sidebar'];
    setShowDrawer(width + 320 > window.innerWidth);
  }, []);

  useEffect(() => {
    if (opened) {
      updateShowDrawer();
      useResizeStore.subscribe((state) => {
        const width = state['generation-sidebar'] ?? 400;
        setShowDrawer(width + 320 > window.innerWidth);
      });
    }
  }, [opened, updateShowDrawer]);

  useWindowEvent('resize', updateShowDrawer);

  useEffect(() => {
    opened && showDrawer
      ? dialogStore.trigger({
          component: GenerationDrawer,
          id: 'generation-drawer',
          options: { onClose: generationPanel.close },
        })
      : dialogStore.closeById('generation-drawer');
  }, [showDrawer, opened]);

  if (!opened || showDrawer) return null;

  return (
    <ResizableSidebar
      name="generation-sidebar"
      resizePosition="right"
      minWidth={350}
      maxWidth={800}
      defaultWidth={400}
    >
      <ContainerProvider containerName="generation-sidebar">
        <GenerationTabs tabs={isGeneratePage ? ['generate'] : undefined} />
      </ContainerProvider>
    </ResizableSidebar>
  );
}
