import { Drawer } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { useRouter } from 'next/router';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';

// TODO - remove this component
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
      transitionDuration={isGeneratePage ? 0 : 300}
    >
      <GenerationTabs fullScreen />
    </Drawer>
  );
}
