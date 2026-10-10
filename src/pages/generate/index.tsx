import { Group, Tabs } from '@mantine/core';
import { IconClockHour9, IconGridDots } from '@tabler/icons-react';
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
import { Meta } from '~/components/Meta/Meta';
import { useRefreshResidencyOnOpen } from '~/components/ResourceLoad/ResourceResidency';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { generationGraphPanel } from '~/store/generation-graph.store';
import type { GenerationResultsView } from '~/store/generation-panel.store';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { getLoginLink } from '~/utils/login-helpers';

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
    if (hasHistory) history.go(-1);
    else router.push('/');
  };
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.req.url }),
          permanent: false,
        },
      };

    if (!features?.imageGeneration) return { notFound: true };
  },
});

function GenerateLayout({ children }: { children: ReactElement }) {
  const currentUser = useCurrentUser();
  const leave = useLeaveGenerate({ closeGenerator: false });
  const fullScreen = useGenerationPanelFullScreen();
  const muted = !!currentUser?.muted;

  // Leaving /generate keeps the generator open in the sidebar.
  useEffect(() => {
    if (!muted) useGenerationPanelStore.setState({ opened: true });
  }, [muted]);
  useRefreshResidencyOnOpen(!muted);

  if (muted)
    return (
      <AppLayout subNav={null}>
        <GenerationMutedNotice />
      </AppLayout>
    );
  if (fullScreen === undefined) return null;
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
  const view = useGenerationPanelStore((state) => state.view);

  // 'generate' has no tab here (the form is beside the results); fall back to the last results
  // tab during render — deferring to the effect swaps the results view for a frame and drops its scroll.
  const lastResultsViewRef = useRef<GenerationResultsView>(view !== 'generate' ? view : 'queue');
  if (view !== 'generate') lastResultsViewRef.current = view;
  const tabView = lastResultsViewRef.current;

  useEffect(() => {
    if (view === 'generate') generationGraphPanel.setView(tabView);
  }, [view, tabView]);

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
