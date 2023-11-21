import { Drawer, Center, Loader, Text, Stack, Group, Button, CloseButton } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { IconArrowsMaximize } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import { useEffect, useState, useTransition } from 'react';
import { useIsMobile } from '~/hooks/useIsMobile';
import { constants } from '~/server/common/constants';
import { useGenerationStore } from '~/store/generation.store';
import { useDebouncer } from '~/utils/debouncer';

const GenerationTabs = dynamic(() => import('~/components/ImageGeneration/GenerationTabs'), {
  loading: () => (
    <Center
      py="xl"
      sx={(theme) => ({
        [theme.fn.smallerThan('sm')]: {
          position: 'relative',
          height: '600px',
        },
      })}
    >
      <Stack spacing="xs" align="center">
        <Text weight={500}>Loading...</Text>
        <Loader variant="bars" />
      </Stack>
    </Center>
  ),
});

export function GenerationPanel() {
  const debouncer = useDebouncer(300);
  const mobile = useIsMobile({ breakpoint: 'md' });
  const router = useRouter();
  const [, startTransition] = useTransition();

  const opened = useGenerationStore((state) => state.opened);
  const onClose = useGenerationStore((state) => state.close);
  const drawerOptions = useGenerationStore((state) => state.drawerOptions);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => onClose(), [router, onClose]);

  useDidUpdate(() => {
    startTransition(() => {
      if (opened) setShowContent(true);
      else debouncer(() => setShowContent(false));
    });
  }, [opened]); //eslint-disable-line

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      size={mobile ? '90%' : 600}
      position={mobile ? 'bottom' : 'right'}
      zIndex={constants.imageGeneration.drawerZIndex}
      styles={{
        body: { height: '100%' },
        drawer: {
          top: !mobile && !drawerOptions?.fullHeight ? 'var(--mantine-header-height)' : undefined,
          boxShadow:
            '-3px 0px 8px 5px rgba(0, 0, 0, 0.05), rgba(0, 0, 0, 0.05) 0px 20px 25px -5px, rgba(0, 0, 0, 0.04) 0px 10px 10px -5px',
        },
      }}
      withCloseButton={false}
      withOverlay={mobile}
      trapFocus={mobile}
      lockScroll={mobile}
    >
      {!mobile && (
        <Group
          spacing={8}
          pl="md"
          pr={8}
          pt="md"
          pb={8}
          position="apart"
          sx={(theme) => ({
            borderBottom: `1px solid ${
              theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]
            }`,
            boxShadow: theme.shadows.sm,
          })}
        >
          <Button
            radius="xl"
            size="xs"
            variant="filled"
            color="gray"
            onClick={() => router.push('/generate')}
          >
            <Group spacing={4}>
              <IconArrowsMaximize size={16} /> Expand
            </Group>
          </Button>
          <CloseButton onClick={onClose} radius="xl" />
        </Group>
      )}
      {showContent && (
        <GenerationTabs wrapperProps={!mobile ? { h: 'calc(100% - 54px)' } : undefined} />
      )}
    </Drawer>
  );
}
