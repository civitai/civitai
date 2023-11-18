import {
  Affix,
  AppShell,
  Button,
  Center,
  MantineNumberSize,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import React from 'react';

import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { getScrollPosition } from '~/utils/window-helpers';
import { SidebarLayout } from '~/components/AppLayout/SidebarLayout';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';

type AppLayoutPageProps = {
  includeFooter?: boolean;
  padding?: MantineNumberSize;
  sidebarLeft?: () => JSX.Element;
  sidebarRight?: () => JSX.Element;
};

type Props = {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
} & AppLayoutPageProps;

export function AppLayout({
  children,
  renderSearchComponent,
  includeFooter = true,
  padding,
  sidebarLeft = GenerationSidebar,
  sidebarRight,
}: Props) {
  const theme = useMantineTheme();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;
  const flags = useFeatureFlags();

  const [hasFooter, setHasFooter] = useDebouncedState(true, 200);

  useWindowEvent('scroll', () => {
    const scroll = getScrollPosition();
    setHasFooter(scroll.y < 10);
  });

  return (
    <AppShell
      padding={0}
      header={!isBanned ? <AppHeader renderSearchComponent={renderSearchComponent} /> : undefined}
      footer={includeFooter ? <AppFooter /> : undefined}
      className={`theme-${theme.colorScheme}`}
      styles={{
        body: {
          display: 'block',
          maxWidth: '100vw',
        },
        main: {
          paddingLeft: 0,
          paddingRight: 0,
          paddingBottom: 61,
          maxWidth: '100%',
        },
      }}
    >
      {!isBanned ? (
        <>
          <SidebarLayout left={sidebarLeft} right={sidebarRight}>
            {children}
          </SidebarLayout>

          {flags.assistant && (
            <Affix
              // @ts-ignore: ignoring cause target prop accepts string. See: https://v5.mantine.dev/core/portal#specify-target-dom-node
              position={{ bottom: hasFooter ? 70 : 12, right: 12 }}
              zIndex={199}
              style={{ transition: 'bottom 300ms linear' }}
            >
              <AssistantButton mr={4} />
            </Affix>
          )}
        </>
      ) : (
        <Center py="xl">
          <Stack align="center">
            <ThemeIcon size={128} radius={100} color="red">
              <IconBan size={80} />
            </ThemeIcon>
            <Title order={1} align="center">
              You have been banned
            </Title>
            <Text size="lg" align="center">
              This account has been banned and cannot access the site
            </Text>
            <Button onClick={() => signOut()}>Sign out</Button>
          </Stack>
        </Center>
      )}
    </AppShell>
  );
}
