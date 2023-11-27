import {
  Button,
  createStyles,
  useMantineTheme,
  Stack,
  Text,
  Title,
  Center,
  ThemeIcon,
} from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

import React from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { ScrollAreaMain } from '~/components/AppLayout/ScrollAreaMain';

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
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();
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
    <ContainerProvider
      className={cx(`theme-${theme.colorScheme}`, classes.root)}
      containerName="root"
    >
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <div className={classes.wrapper}>
        <GenerationSidebar />
        <ContainerProvider className={classes.content} containerName="main">
          <main className={classes.main}>{content}</main>
          <AppFooter fixed={false} />
        </ContainerProvider>
      </div>
    </ContainerProvider>
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
    overflow: 'clip',
  },
  wrapper: {
    display: 'flex',
    flex: 1,
    overflow: 'clip',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'clip',
    position: 'relative',
  },
  assistant: {
    position: 'sticky',
    bottom: 0,
    left: '100%',
    display: 'inline-block',
    marginRight: theme.spacing.md,
  },
}));

export function setPageOptions(Component: () => JSX.Element, options?: AppLayoutProps) {
  (Component as any).options = options;
}
