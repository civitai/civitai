import { Button, createStyles, Stack, Text, Title, Center, ThemeIcon } from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

import React from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { ScrollArea } from '~/components/ScrollArea/ScrollArea';
import { FloatingActionButton2 } from '~/components/FloatingActionButton/FloatingActionButton';

type AppLayoutProps = {
  innerLayout?: (page: React.ReactNode) => React.ReactNode;
  withScrollArea?: boolean;
};

export function AppLayout({
  children,
  renderSearchComponent,
  innerLayout,
  withScrollArea = true,
}: {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
} & AppLayoutProps) {
  const { classes } = useStyles();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;
  const flags = useFeatureFlags();

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

  const content = innerLayout ? (
    innerLayout(children)
  ) : withScrollArea ? (
    <ScrollArea>{children}</ScrollArea>
  ) : (
    children
  );

  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <div className={classes.wrapper}>
        <GenerationSidebar />

        <ContainerProvider containerName="main">
          <main className={classes.main}>
            {content}
            {/* {flags.assistant && (
              <div className={classes.assistant}>
                <AssistantButton />
              </div>
            )} */}
            <FloatingActionButton2 mounted={flags.assistant} transition="slide-up">
              <AssistantButton />
            </FloatingActionButton2>
          </main>
          <AppFooter fixed={false} />
        </ContainerProvider>
      </div>
    </>
  );
}

const useStyles = createStyles((theme) => ({
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
    position: 'relative',
  },
  assistant: {
    position: 'absolute',
    // top: '100%',
    // left: '100%',
    bottom: theme.spacing.xs,
    right: theme.spacing.md,
    display: 'inline-block',
    zIndex: 20,
    width: 42,
  },
}));

export function setPageOptions(Component: (...args: any) => JSX.Element, options?: AppLayoutProps) {
  (Component as any).options = options;
}
