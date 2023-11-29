import { Group, ActionIcon, CloseButton, Button } from '@mantine/core';
import { useWindowEvent } from '@mantine/hooks';
import { IconArrowsMaximize } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
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
        {!isGeneratePage && (
          <Group
            position="apart"
            p="xs"
            sx={(theme) => ({
              position: 'relative',
              borderBottom: `1px solid ${
                theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
              }`,
            })}
          >
            <Button
              radius="xl"
              size="sm"
              variant="filled"
              onClick={() => router.push('/generate')}
              leftIcon={<IconArrowsMaximize size={16} />}
            >
              Expand
            </Button>
            <GeneratedImageActions
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
              }}
            />
            <CloseButton onClick={generationPanel.close} size="lg" />
          </Group>
        )}
        <GenerationTabs tabs={isGeneratePage ? ['generate'] : undefined} />
      </ContainerProvider>
    </ResizableSidebar>
  );
}
