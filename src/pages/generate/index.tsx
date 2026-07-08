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
import {
  createServerSideProps,
  prefetchGeneratorQueries,
} from '~/server/utils/server-side-helpers';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * NOTE: This is still a WIP. We are currently working on a new design for the
 * image generation page. This is a temporary page until we have the new design
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  // Enable the SSG helper so `trpcState` is dehydrated into the page props — the
  // vehicle the flag-gated generator prefetch (below) hydrates from. On full SSR
  // this also lets the shared `ssrPrefetchShell` prefetch run; on a client-nav
  // `/_next/data` fetch no `ssg` is built (`prefetch: 'once'`), so neither the
  // shell nor the generator prefetch fires — same skip contract as #2990.
  useSSG: true,
  resolver: async ({ session, features, ssg, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.req.url }),
          permanent: false,
        },
      };

    if (!features?.imageGeneration) return { notFound: true };

    // Flag-gated, best-effort SSR-prefetch of the generator's static init queries
    // so they hydrate instead of round-tripping on mount. Only runs on full SSR
    // (where `ssg` exists) for authed users with the flag on; never throws / hangs
    // (bounded, `allSettled`) so it can't slow or break this money-path render.
    if (ssg && features?.ssrPrefetchGenerator) {
      await prefetchGeneratorQueries(ssg, session, features);
    }
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
