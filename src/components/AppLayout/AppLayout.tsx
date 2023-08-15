import {
  AppShell,
  Button,
  Center,
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
import { FloatingGenerationButton } from '~/components/ImageGeneration/FloatingGenerationButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function AppLayout({ children, navbar, renderSearchComponent }: Props) {
  const theme = useMantineTheme();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;
  const flags = useFeatureFlags();

  return (
    <AppShell
      padding="md"
      header={!isBanned ? <AppHeader renderSearchComponent={renderSearchComponent} /> : undefined}
      footer={<AppFooter />}
      className={`theme-${theme.colorScheme}`}
      navbar={navbar}
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
          {children}
          {flags.imageGeneration && <FloatingGenerationButton />}
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

type Props = {
  children: React.ReactNode;
  navbar?: React.ReactElement;
  renderSearchComponent?: (opts: RenderSearchComponentProps) => React.ReactElement;
};
