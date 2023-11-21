import {
  Button,
  createStyles,
  useMantineTheme,
  Stack,
  Text,
  Title,
  Center,
  ThemeIcon,
  Affix,
  Box,
} from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

import React, { ComponentType, cloneElement } from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { ScrollArea } from '~/components/Layout/ScrollArea';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';

type AppLayoutProps = {
  innerLayout?: (page: React.ReactNode) => React.ReactNode;
  pageClass?: string;
  pageStyle?: React.CSSProperties;
};

export function AppLayout({
  children,
  innerLayout,
  pageClass,
  pageStyle,
}: { children: React.ReactNode } & AppLayoutProps) {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;
  const flags = useFeatureFlags();

  // TODO - return banned
  if (isBanned)
    return (
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
    );

  const content = innerLayout ? innerLayout(children) : children;

  return (
    <div className={cx(`theme-${theme.colorScheme}`, classes.root)}>
      <AppHeader fixed={false} />
      <div className={classes.wrapper}>
        <GenerationSidebar />
        <div className={classes.content}>
          <main className={classes.main}>
            {pageClass ? (
              <div className={pageClass} style={pageStyle}>
                {content}
              </div>
            ) : (
              <ScrollArea style={pageStyle}>{content}</ScrollArea>
            )}
          </main>
          <AppFooter fixed={false} />
        </div>
      </div>
      {/* {flags.assistant && (
        <Affix
          // @ts-ignore: ignoring cause target prop accepts string. See: https://v5.mantine.dev/core/portal#specify-target-dom-node
          position={{ bottom: hasFooter ? 70 : 12, right: 12 }}
          zIndex={199}
          style={{ transition: 'bottom 300ms linear' }}
        >
          <AssistantButton mr={4} />
        </Affix>
      )} */}
    </div>
  );
}

const useStyles = createStyles((theme) => ({
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    flex: 1,
    overflow: 'hidden',
  },
  wrapper: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    containerName: 'main',
    containerType: 'inline-size',
  },
}));

export function setPageOptions(Component: () => JSX.Element, options?: AppLayoutProps) {
  (Component as any).options = options;
}
