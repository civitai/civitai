import { ConversationsSidebar } from '~/components/Conversations/ConversationsSidebar';
import { AppShell, Header, Text } from '@mantine/core';

// TODO: Create conversations provider to maintain states
export default function ConversationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      navbarOffsetBreakpoint="sm"
      asideOffsetBreakpoint="sm"
      navbar={<ConversationsSidebar />}
      header={
        <Header height={{ base: 50, md: 70 }} p="md">
          <div style={{ display: 'flex', alignItems: 'center', height: '100%' }}>
            {/* <MediaQuery largerThan="sm" styles={{ display: 'none' }}>
              <Burger
                opened={opened}
                onClick={() => setOpened((o) => !o)}
                size="sm"
                color={theme.colors.gray[6]}
                mr="xl"
              />
            </MediaQuery> */}

            <Text>Civitai Chat</Text>
          </div>
        </Header>
      }
    >
      {children}
    </AppShell>
  );
}
