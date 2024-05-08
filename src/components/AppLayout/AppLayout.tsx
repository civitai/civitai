import { Button, Center, createStyles, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconBan } from '@tabler/icons-react';
import React from 'react';
import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader, RenderSearchComponentProps } from '~/components/AppLayout/AppHeader';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { useAccountContext } from '~/components/CivitaiWrapped/AccountProvider';
import { FloatingActionButton2 } from '~/components/FloatingActionButton/FloatingActionButton';
import { ScrollAreaMain } from '~/components/ScrollArea/ScrollAreaMain';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NewsletterDialog } from '../NewsletterDialog/NewsletterDialog';

type AppLayoutProps = {
  innerLayout?: ({ children }: { children: React.ReactNode }) => React.ReactNode;
  withScrollArea?: boolean;
};

export function AppLayout({
  children,
  renderSearchComponent,
}: {
  children: React.ReactNode;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
}) {
  const { classes } = useStyles();
  const user = useCurrentUser();
  const { logout } = useAccountContext();
  // TODO - move the bannedAt check to _app.tsx
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
          <Button onClick={() => logout()}>Sign out</Button>
        </Stack>
      </Center>
    );

  return (
    <>
      <AppHeader fixed={false} renderSearchComponent={renderSearchComponent} />
      <main className="flex flex-col flex-1 w-full h-full relative overflow-hidden">
        {children}
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
      {/* Disabling because this is popping in too frequently */}
      {/* <NewsletterDialog /> */}
    </>
  );
}

const useStyles = createStyles((theme) => ({
  wrapper: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
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
