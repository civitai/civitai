import { ConversationsSidebar } from '~/components/Conversations/ConversationsSidebar';
import { Grid } from '@mantine/core';

export default function ConversationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Grid>
      <Grid.Col span={4}>
        <ConversationsSidebar />
      </Grid.Col>
      <Grid.Col span={8}>{children}</Grid.Col>
    </Grid>
  );
}
