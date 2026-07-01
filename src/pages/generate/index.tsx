import { Group, Tabs } from '@mantine/core';
import { IconClockHour9, IconGridDots } from '@tabler/icons-react';
import React, { useRef } from 'react';
import { Page } from '~/components/AppLayout/Page';
import { GenerationMutedNotice } from '~/components/Generation/GenerationMutedNotice';
import { Feed } from '~/components/ImageGeneration/Feed';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GeneratedRequestsProvider } from '~/components/ImageGeneration/GeneratedRequestsProvider';
import { Queue } from '~/components/ImageGeneration/Queue';
import {
  SelectionProvider,
  generatedImageSelectStore,
} from '~/components/ImageGeneration/utils/generationImage.select';
import { Meta } from '~/components/Meta/Meta';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * NOTE: This is still a WIP. We are currently working on a new design for the
 * image generation page. This is a temporary page until we have the new design
 */
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

function GeneratePage() {
  const currentUser = useCurrentUser();
  const view = useGenerationPanelStore((state) => state.view);
  const setView = generationGraphPanel.setView;

  // On this page the generate form lives in the sidebar, so the tabs only
  // switch between queue and feed. Ignore transient 'generate' values
  // (e.g. from workflow menu items) to avoid unmounting content and losing
  // scroll position.
  const tabViewRef = useRef<'queue' | 'feed'>(view !== 'generate' ? view : 'queue');
  if (view !== 'generate') tabViewRef.current = view as 'queue' | 'feed';
  const tabView = view === 'generate' ? tabViewRef.current : view;

  if (currentUser?.muted) return <GenerationMutedNotice />;

  // desktop view
  return (
    <SelectionProvider store={generatedImageSelectStore}>
      <GeneratedRequestsProvider>
        <Meta title="Generate" deIndex />

        <Tabs
          variant="pills"
          value={tabView}
          onChange={(view) => {
            // tab can be null
            if (view) setView(view as 'generate' | 'queue' | 'feed');
          }}
          radius="xl"
          color="gray"
          classNames={{
            root: 'flex flex-1 flex-col overflow-hidden',
            panel: 'size-full',
          }}
          keepMounted={false}
        >
          {/* Keep the actions row OUTSIDE Tabs.List: a role="tablist" must have
              only role="tab" children (a11y: aria-required-children). The list
              holds just the tabs; the surrounding Group carries the layout. */}
          <Group
            justify="space-between"
            wrap="nowrap"
            px="md"
            py="xs"
            className="w-full border-b border-b-gray-2 dark:border-b-dark-5"
          >
            <Tabs.List className="gap-2">
              <Tabs.Tab value="queue" leftSection={<IconClockHour9 size={16} />}>
                Queue
              </Tabs.Tab>
              <Tabs.Tab value="feed" leftSection={<IconGridDots size={16} />}>
                Feed
              </Tabs.Tab>
            </Tabs.List>
            <GeneratedImageActions />
          </Group>
          <ScrollArea scrollRestore={{ key: tabView }}>
            <Tabs.Panel value="queue">
              <Queue />
            </Tabs.Panel>
            <Tabs.Panel value="feed">
              <Feed />
            </Tabs.Panel>
          </ScrollArea>
        </Tabs>
      </GeneratedRequestsProvider>
    </SelectionProvider>
  );
}

export default Page(GeneratePage, {
  scrollable: false,
  subNav: null,
});
