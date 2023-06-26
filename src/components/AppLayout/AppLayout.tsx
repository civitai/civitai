import {
  AppShell,
  Button,
  Center,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { IconBan, IconBrush } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

import { AppFooter } from '~/components/AppLayout/AppFooter';
import { AppHeader } from '~/components/AppLayout/AppHeader';
import { SideNavigation } from '~/components/AppLayout/SideNavigation';
import { FloatingActionButton } from '~/components/FloatingActionButton/FloatingActionButton';
import { GenerationDrawer } from '~/components/ImageGeneration/GenerationDrawer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useGenerationStore } from '~/store/generation.store';

export function AppLayout({ children, showNavbar }: Props) {
  const { colorScheme } = useMantineTheme();
  const user = useCurrentUser();
  const isBanned = !!user?.bannedAt;
  const flags = useFeatureFlags();

  const drawerOpened = useGenerationStore((state) => state.drawerOpened);
  const toggleDrawer = useGenerationStore((state) => state.toggleDrawer);

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
            {/* TODO.generation: Move this out of AppLayout so drawer can be opened anywhere */}
            {flags.imageGeneration && (
              <>
                <GenerationDrawer opened={drawerOpened} onClose={toggleDrawer} />
                <FloatingActionButton
                  transition="pop"
                  onClick={toggleDrawer}
                  mounted={!drawerOpened}
                  px="xs"
                >
                  <Group spacing="xs">
                    <IconBrush size={20} />
                    <Text inherit>Create</Text>
                  </Group>
                </FloatingActionButton>
              </>
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
    </>
  );
}

type Props = {
  children: React.ReactNode;
  showNavbar?: boolean;
};
