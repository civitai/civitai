import { Button, Center, Group, Stack, Tabs, Text } from '@mantine/core';
import { IconClockHour9, IconGridDots, IconInbox } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import type { ReactElement } from 'react';
import React, { useEffect, useRef } from 'react';
import { AppLayout, useAppLayoutPrompts } from '~/components/AppLayout/AppLayout';
import { Page } from '~/components/AppLayout/Page';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { GenerationMutedNotice } from '~/components/Generation/GenerationMutedNotice';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GenerationResults } from '~/components/ImageGeneration/GenerationResults';
import {
  GenerationColumn,
  GenerationSurface,
} from '~/components/ImageGeneration/GenerationSidebar';
import { useGenerationPanelFullScreen } from '~/components/ImageGeneration/useGenerationPanelFullScreen';
import {
  SelectionProvider,
  generatedImageSelectStore,
} from '~/components/ImageGeneration/utils/generationImage.select';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Meta } from '~/components/Meta/Meta';
import { useRefreshResidencyOnOpen } from '~/components/ResourceLoad/ResourceResidency';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';
import { historyLayerDepth } from '~/utils/history-layers';
import type { GenerationResultsView } from '~/store/generation-panel.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';

const GenerationPanel = dynamic(() => import('~/components/ImageGeneration/GenerationTabs'));
const GenerationFormPane = dynamic(() =>
  import('~/components/ImageGeneration/GenerationTabs').then((m) => m.GenerationFormPane)
);

function useLeaveGenerate({ closeGenerator }: { closeGenerator: boolean }) {
  const router = useRouter();
  const hasHistory = useHasClientHistory();
  return () => {
    // Full-screen, the panel left open would cover the page the user is going back to.
    if (closeGenerator) generationGraphPanel.close();
    // Go back past the layers open over the page (the form sheet, a picker) too.
    if (hasHistory) history.go(-(1 + historyLayerDepth()));
    else router.push('/');
  };
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.imageGeneration) return { notFound: true };
  },
});

function GenerateLayout({ children }: { children: ReactElement }) {
  const currentUser = useCurrentUser();
  const leave = useLeaveGenerate({ closeGenerator: false });
  const fullScreen = useGenerationPanelFullScreen();
  const mobileGenerator = useMobileGenerator();
  const muted = !!currentUser?.muted;

  // Leaving /generate keeps the generator open in the sidebar.
  useEffect(() => {
    if (!muted) useGenerationPanelStore.setState({ opened: true });
  }, [muted]);
  // On a phone the generator is this page: leaving it closes the panel, or the next page would
  // send it straight back here. Above the muted return, so the notice is covered too.
  useEffect(() => {
    if (mobileGenerator) return () => generationGraphPanel.close();
  }, [mobileGenerator]);
  useRefreshResidencyOnOpen(!muted);

  if (muted)
    return (
      <AppLayout subNav={null}>
        <GenerationMutedNotice />
      </AppLayout>
    );
  // Undefined until mounted, so the server and the first client render agree.
  if (fullScreen === undefined) return null;
  if (mobileGenerator) return <FullScreenGenerator />;
  if (fullScreen) return <FullScreenGenerator />;

  return (
    <div className="flex flex-1 overflow-hidden">
      <GenerationColumn className="z-10">
        <GenerationFormPane onClose={leave} closeLabel="Go back" />
      </GenerationColumn>
      <ContainerProvider containerName="generate-results" className="flex-1">
        <AppLayout subNav={null} scrollable={false}>
          {children}
        </AppLayout>
      </ContainerProvider>
    </div>
  );
}

function FullScreenGenerator() {
  useAppLayoutPrompts();
  const leave = useLeaveGenerate({ closeGenerator: true });
  return (
    <GenerationSurface>
      <Meta title="Generate" deIndex />
      <GenerationPanel onClose={leave} closeLabel="Go back" />
    </GenerationSurface>
  );
}

function GenerateResults() {
  const currentUser = useCurrentUser();
  const view = useGenerationPanelStore((state) => state.view);

  // 'generate' has no tab here (the form is beside the results); fall back to the last results
  // tab during render — deferring to the effect swaps the results view for a frame and drops its scroll.
  const lastResultsViewRef = useRef<GenerationResultsView>(view !== 'generate' ? view : 'queue');
  if (view !== 'generate') lastResultsViewRef.current = view;
  const tabView = lastResultsViewRef.current;

  useEffect(() => {
    if (view === 'generate') generationGraphPanel.setView(tabView);
  }, [view, tabView]);

  if (!currentUser)
    return (
      <>
        <Meta title="Generate" deIndex />
        <Center h="100%" p="md">
          <Stack gap="xs" align="center">
            <IconInbox size={64} stroke={1} />
            <Text align="center">Sign in to see your generations</Text>
            <LoginRedirect reason="image-gen">
              <Button>Sign in</Button>
            </LoginRedirect>
          </Stack>
        </Center>
      </>
    );

  return (
    <SelectionProvider store={generatedImageSelectStore}>
      <Meta title="Generate" deIndex />
      <Tabs
        variant="pills"
        value={tabView}
        onChange={(view) => {
          if (view) generationGraphPanel.setView(view as GenerationResultsView);
        }}
        radius="xl"
        color="gray"
        classNames={{ root: 'flex flex-1 flex-col overflow-hidden' }}
      >
        {/* Keep the actions row OUTSIDE Tabs.List: a role="tablist" must have
              only role="tab" children (a11y: aria-required-children). */}
        <Group
          justify="space-between"
          px="md"
          py="xs"
          className="w-full border-b border-b-gray-2 dark:border-b-dark-5"
        >
          <Tabs.List className="gap-2.5">
            <Tabs.Tab value="queue" leftSection={<IconClockHour9 size={16} />}>
              Queue
            </Tabs.Tab>
            <Tabs.Tab value="feed" leftSection={<IconGridDots size={16} />}>
              Feed
            </Tabs.Tab>
          </Tabs.List>
          <GeneratedImageActions />
        </Group>
        <GenerationResults view={tabView} />
      </Tabs>
    </SelectionProvider>
  );
}

export default Page(GenerateResults, {
  getLayout: (page) => <GenerateLayout>{page}</GenerateLayout>,
});
