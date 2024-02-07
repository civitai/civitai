import { Group, ActionIcon, CloseButton, Button, Tooltip } from '@mantine/core';
import { useWindowEvent } from '@mantine/hooks';
import { IconArrowsDiagonal, IconArrowsMaximize } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { FeatureIntroduction } from '~/components/FeatureIntroduction/FeatureIntroduction';
import { HelpButton } from '~/components/HelpButton/HelpButton';
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
        <Group
          position="right"
          p="xs"
          spacing="xs"
          sx={(theme) => ({
            position: 'relative',
            borderBottom: `1px solid ${
              theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
            }`,
          })}
        >
          <FeatureIntroduction
            feature="image-generator"
            contentSlug={['feature-introduction', 'image-generator']}
            actionButton={<HelpButton size="md" radius="xl" mr="auto" />}
          />
          {!isGeneratePage && (
            <>
              <GeneratedImageActions />
              <Tooltip label="Maximize">
                <ActionIcon size="lg" onClick={() => router.push('/generate')} variant="light">
                  <IconArrowsDiagonal size={20} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
          <CloseButton
            onClick={!isGeneratePage ? generationPanel.close : () => history.go(-1)}
            size="lg"
            variant="light"
          />
        </Group>
        <GenerationTabs tabs={isGeneratePage ? ['generate'] : undefined} />
      </ContainerProvider>
    </ResizableSidebar>
  );
}
