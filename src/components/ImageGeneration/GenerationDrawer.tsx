import { CloseButton, Drawer, Group, Box } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';

export function GenerationDrawer() {
  const dialog = useDialogContext();
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const isGeneratePage = router.pathname.startsWith('/generate');

  // close the generation drawer when navigating to a new page
  useDidUpdate(() => {
    if (!isGeneratePage) dialog.onClose();
  }, [browserRouter.asPath]); //eslint-disable-line

  return (
    <Drawer
      {...dialog}
      size="100%"
      position="left"
      withOverlay={false}
      withCloseButton={false}
      styles={isGeneratePage ? { drawer: { top: `var(--mantine-header-height)` } } : undefined}
      transitionDuration={isGeneratePage ? 0 : 300}
    >
      <Box
        sx={(theme) => ({
          borderBottom: `1px solid ${
            theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[3]
          }`,
        })}
      >
        <Group position="right" p="xs" spacing="xs" style={{ position: 'relative' }}>
          <GeneratedImageActions
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
            }}
          />
          <CloseButton
            size="lg"
            onClick={!isGeneratePage ? dialog.onClose : () => history.go(-1)}
          />
        </Group>
      </Box>
      <GenerationTabs />
    </Drawer>
  );
}
