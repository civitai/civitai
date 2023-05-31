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
import { useDisclosure } from '@mantine/hooks';
import { IconBan, IconBolt } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';
import { MouseEvent } from 'react';

import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { SideNavigation } from '~/components/AppLayout/SideNavigation';
import { FloatingActionButton } from '~/components/FloatingActionButton/FloatingActionButton';
import { GenerationDrawer } from '~/components/ImageGeneration/GenerationDrawer';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function AppLayout({ children, showNavbar }: Props) {
  const { colorScheme } = useMantineTheme();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;

  const [opened, { open, close }] = useDisclosure();

  return (
    <>
      <AppShell
        padding="md"
        header={!isBanned ? <AppHeader /> : undefined}
        footer={<AppFooter />}
        className={`theme-${colorScheme}`}
        navbar={showNavbar ? <SideNavigation /> : undefined}
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
            <GenerationDrawer opened={opened} onClose={close} />
            <FloatingActionButton transition="pop" onClick={open} mounted={!opened}>
              <IconBolt />
            </FloatingActionButton>
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
    </>
  );
}

type Props = {
  children: React.ReactNode;
  showNavbar?: boolean;
};
