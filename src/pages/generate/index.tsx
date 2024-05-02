import { Center, Group, Stack, Tabs, Text, ThemeIcon, createStyles } from '@mantine/core';
import { IconClock, IconClockHour9, IconLayoutList } from '@tabler/icons-react';
import { IconGridDots, IconLock } from '@tabler/icons-react';
import React, { useState } from 'react';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { Feed } from '~/components/ImageGeneration/Feed';
import { GeneratedImageActions } from '~/components/ImageGeneration/GeneratedImageActions';
import { GenerationProvider } from '~/components/ImageGeneration/GenerationProvider';
import { Queue } from '~/components/ImageGeneration/Queue';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { GenerationPanelView, useGenerationStore } from '~/store/generation.store';
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

export default function GeneratePage() {
  const currentUser = useCurrentUser();
  const { classes } = useStyles();
  const view = useGenerationStore((state) => state.view);
  const setView = useGenerationStore((state) => state.setView);

  if (currentUser?.muted)
    return (
      <Center h="100%" w="75%" mx="auto">
        <Stack spacing="xl" align="center">
          <ThemeIcon size="xl" radius="xl" color="yellow">
            <IconLock />
          </ThemeIcon>
          <Text align="center">
            Your account has been restricted due to potential Terms of Service violations, and has
            been flagged for review. A Community Manager will investigate, and you will receive a
            determination notification within 48 hours. You do not need to contact us.
          </Text>
        </Stack>
      </Center>
    );

  // desktop view
  return (
    <GenerationProvider>
      <Tabs
        variant="pills"
        value={view}
        onTabChange={(view) => {
          // tab can be null
          if (view) setView(view as GenerationPanelView);
        }}
        radius="xl"
        color="gray"
        classNames={classes}
      >
        <Tabs.List px="md" py="xs">
          <Group position="apart" w="100%">
            <Group align="flex-start" spacing="xs">
              <Tabs.Tab value="queue" icon={<IconClockHour9 size={16} />}>
                Queue
              </Tabs.Tab>
              <Tabs.Tab value="feed" icon={<IconGridDots size={16} />}>
                Feed
              </Tabs.Tab>
            </Group>
            <GeneratedImageActions />
          </Group>
        </Tabs.List>
        <ScrollArea scrollRestore={{ key: view }} py={0}>
          <Tabs.Panel value="queue">
            <Queue />
          </Tabs.Panel>
          <Tabs.Panel value="feed">
            <Feed />
          </Tabs.Panel>
        </ScrollArea>
      </Tabs>
    </GenerationProvider>
  );
}

setPageOptions(GeneratePage, { withScrollArea: false });

const useStyles = createStyles((theme) => {
  // const sidebarWidth = 400;
  // const sidebarWidthLg = 600;
  return {
    // mobileContent: {
    //   position: 'fixed',
    //   top: 'var(--mantine-header-height)',
    //   left: 0,
    //   right: 0,
    //   bottom: 0,
    // },
    // tab: {
    //   '&[data-active]': {
    //     backgroundColor: theme.fn.rgba(theme.colors.blue[7], 0.7),
    //   },
    // },
    root: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    panel: {
      height: '100%',
      width: '100%',
    },
    tabsList: {
      width: '100%',
      borderBottom:
        theme.colorScheme === 'dark'
          ? `1px solid ${theme.colors.dark[5]}`
          : `1px solid ${theme.colors.gray[2]}`,
    },
  };
});
