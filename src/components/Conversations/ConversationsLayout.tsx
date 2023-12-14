import { ConversationsSidebar } from '~/components/Conversations/ConversationsSidebar';
import { Grid } from '@mantine/core';

// TODO: Maybe use AppShell
export default function ConversationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Grid>
      <Grid.Col span={2}>
        <ConversationsSidebar />
      </Grid.Col>
      <Grid.Col span={10}>{children}</Grid.Col>
    </Grid>
  );
}
