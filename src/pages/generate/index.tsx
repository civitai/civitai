import {
  Center,
  Container,
  Group,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { usePrevious } from '@mantine/hooks';
import { IconLock } from '@tabler/icons-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Feed, FloatingFeedActions } from '~/components/ImageGeneration/Feed';
import { GenerationForm } from '~/components/ImageGeneration/GenerationForm/GenerationForm';
import { usePreserveVerticalScrollPosition } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';
import { Queue } from '~/components/ImageGeneration/Queue';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';

import { usePageScrollRestore } from '~/components/ScrollRestoration/ScrollRestoration';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

/**
 * NOTE: This is still a WIP. We are currently working on a new design for the
 * image generation page. This is a temporary page until we have the new design
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    // Temporary until we have the new designs available
    // if (!session?.user?.isModerator) return { notFound: true };
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
  const { classes, cx } = useStyles();
  const isMobile = useIsMobile();
  const isClient = useIsClient();
  const [tab, setTab] = useState<string>('queue');

  const result = useGetGenerationRequests({ take: 5 });
  usePageScrollRestore({
    key: tab,
    condition: !!result.data,
  });

  // usePreserveVerticalScrollPosition({
  //   data: result.requests,
  //   node: typeof window !== 'undefined' ? document.querySelector('html') : null,
  // });

  if (currentUser?.muted)
    return (
      <Center h="100%" w="75%" mx="auto">
        <Stack spacing="xl" align="center">
          <ThemeIcon size="xl" radius="xl" color="yellow">
            <IconLock />
          </ThemeIcon>
          <Text align="center">You cannot create new generations because you have been muted</Text>
        </Stack>
      </Center>
    );

  // mobile view
  if (!isClient) return null;
  if (isMobile)
    return (
      <div className={classes.mobileContent}>
        <GenerationTabs />
      </div>
    );

  // desktop view
  return (
    <>
      <div className={classes.sidebar}>
        <GenerationForm />
      </div>
      <div className={classes.content}>
        <Tabs
          variant="pills"
          value={tab}
          onTabChange={(tab) => {
            // tab can be null
            if (tab) setTab(tab);
          }}
          radius="xl"
          color="gray"
          mb="md"
        >
          <Tabs.List p="md" mt={-16} className={classes.tabList}>
            <Container fluid sx={{ width: '100%' }}>
              <Group position="apart">
                <Group align="flex-start">
                  <Tabs.Tab value="queue">Queue</Tabs.Tab>
                  <Tabs.Tab value="feed">Feed</Tabs.Tab>
                </Group>
                <FloatingFeedActions images={result.images} />
              </Group>
            </Container>
          </Tabs.List>
          <Container fluid px={0}>
            <Tabs.Panel value="queue">
              <Queue {...result} />
            </Tabs.Panel>
            <Tabs.Panel value="feed" p="md">
              <Feed {...result} />
            </Tabs.Panel>
          </Container>
        </Tabs>
      </div>
    </>
  );
}

const useStyles = createStyles((theme) => {
  const sidebarWidth = 400;
  const sidebarWidthLg = 600;
  return {
    mobileContent: {
      position: 'fixed',
      top: 'var(--mantine-header-height)',
      left: 0,
      right: 0,
      bottom: 0,
    },
    sidebar: {
      position: 'fixed',
      top: 'var(--mantine-header-height)',
      left: 0,
      width: sidebarWidth,
      height: 'calc(100% - var(--mantine-header-height))',
      display: 'flex',
      borderRight:
        theme.colorScheme === 'dark'
          ? `1px solid ${theme.colors.dark[5]}`
          : `1px solid ${theme.colors.gray[2]}`,

      [`@media (min-width: ${theme.breakpoints.lg}px)`]: {
        width: sidebarWidthLg,
      },
    },
    content: {
      marginLeft: sidebarWidth,
      // height: 'calc(100% - var(--mantine-header-height))',
      // overflow: 'hidden',
      // marginBottom: -61,

      [`@media (min-width: ${theme.breakpoints.lg}px)`]: {
        marginLeft: sidebarWidthLg,
      },
    },
    tabList: {
      position: 'sticky',
      top: `var(--mantine-header-height)`,
      alignSelf: 'flex-start',
      zIndex: 100,
      background: theme.colorScheme === 'dark' ? theme.colors.dark[7] : '#fff',
      borderBottom:
        theme.colorScheme === 'dark'
          ? `1px solid ${theme.colors.dark[5]}`
          : `1px solid ${theme.colors.gray[2]}`,
    },
  };
});
