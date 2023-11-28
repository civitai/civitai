import { Button, createStyles, Stack, Text, Title, Center, ThemeIcon } from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

import React from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { ScrollAreaMain } from '~/components/AppLayout/ScrollAreaMain';
import { ResizableSidebar } from '~/components/Resizable/ResizableSidebar';
import GenerationTabs from '~/components/ImageGeneration/GenerationTabs';

type AppLayoutProps = {
  innerLayout?: (page: React.ReactNode) => React.ReactNode;
};

export function AppLayout({
  children,
  innerLayout,
  renderSearchComponent,
}: {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
} & AppLayoutProps) {
  const { classes } = useStyles();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;

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

  const content = innerLayout ? innerLayout(children) : <ScrollAreaMain>{children}</ScrollAreaMain>;

  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <div className={classes.wrapper}>
        <ResizableSidebar resizePosition="right" minWidth={300} maxWidth={800} defaultWidth={400}>
          <ContainerProvider containerName="left-sidebar">
            <GenerationTabs />
          </ContainerProvider>
        </ResizableSidebar>

        <ContainerProvider containerName="main">
          <main className={classes.main}>{content}</main>
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
}));

export function setPageOptions(Component: (...args: any) => JSX.Element, options?: AppLayoutProps) {
  (Component as any).options = options;
}
