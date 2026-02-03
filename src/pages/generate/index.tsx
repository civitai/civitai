import { Group, Tabs } from '@mantine/core';
import { IconClockHour9, IconGridDots } from '@tabler/icons-react';
import React from 'react';
import { Page } from '~/components/AppLayout/Page';
import { GenerationMutedNotice } from '~/components/Generation/GenerationMutedNotice';
import { Feed } from '~/components/ImageGeneration/Feed';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { Queue } from '~/components/ImageGeneration/Queue';
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

  if (currentUser?.muted) return <GenerationMutedNotice />;

  // desktop view
  return (
    <>
      <Meta title="Generate" deIndex />

      <Tabs
        variant="pills"
        value={view}
        onChange={(view) => {
          // tab can be null
          if (view) setView(view as 'generate' | 'queue' | 'feed');
        }}
        radius="xl"
        color="gray"
        classNames={{
          root: 'flex flex-1 flex-col overflow-hidden',
          panel: 'size-full',
          list: 'w-full border-b border-b-gray-2 dark:border-b-dark-5',
        }}
        keepMounted={false}
      >
        <Tabs.List px="md" py="xs">
          <Group justify="space-between" w="100%">
            <Group align="flex-start" gap="xs">
              <Tabs.Tab value="queue" leftSection={<IconClockHour9 size={16} />}>
                Queue
              </Tabs.Tab>
              <Tabs.Tab value="feed" leftSection={<IconGridDots size={16} />}>
                Feed
              </Tabs.Tab>
            </Group>
            <GeneratedImageActions />
          </Group>
        </Tabs.List>
        <ScrollArea scrollRestore={{ key: view }}>
          <Tabs.Panel value="queue">
            <Queue />
          </Tabs.Panel>
          <Tabs.Panel value="feed">
            <Feed />
          </Tabs.Panel>
        </ScrollArea>
      </Tabs>
    </>
  );
}

export default Page(GeneratePage, {
  scrollable: false,
  subNav: null,
});
