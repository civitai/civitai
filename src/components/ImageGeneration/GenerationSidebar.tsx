import { Group, ActionIcon, CloseButton } from '@mantine/core';
import { useWindowEvent } from '@mantine/hooks';
import { IconArrowsMaximize } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GenerationDrawer } from '~/components/ImageGeneration/GenerationDrawer';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';
import { useResizeStore } from '~/components/Resizable/useResize';
import { generationPanel, useGenerationStore } from '~/store/generation.store';

export function GenerationSidebar() {
  const opened = useGenerationStore((state) => state.opened);
  const router = useRouter();
  const [showDrawer, setShowDrawer] = useState(false);

  useEffect(() => {
    if (opened)
      useResizeStore.subscribe((state) => {
        const width = state['generation-sidebar'] ?? 400;
        setShowDrawer(width + 320 > window.innerWidth);
      });
  }, [opened]);

  useWindowEvent('resize', () => {
    const width = useResizeStore.getState()['generation-sidebar'];
    setShowDrawer(width + 320 > window.innerWidth);
  });

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
      minWidth={300}
      maxWidth={800}
      defaultWidth={400}
    >
      <ContainerProvider containerName="generation-sidebar">
        <Group position="apart" p="xs">
          <ActionIcon
            radius="xl"
            size="md"
            variant="filled"
            onClick={() => router.push('/generate')}
            sx={(theme) => ({
              backgroundColor: theme.white,
              '&:hover': {
                backgroundColor: theme.colors.gray[1],
              },
            })}
          >
            <IconArrowsMaximize size={16} color="black" />
          </ActionIcon>
          <CloseButton onClick={generationPanel.close} />
        </Group>
        <GenerationTabs />
      </ContainerProvider>
    </ResizableSidebar>
  );
}
