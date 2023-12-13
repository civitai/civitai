import { createServerSideProps } from '~/server/utils/server-side-helpers';
// import { trpc } from '~/utils/trpc';
import { ConversationsSidebar } from '~/components/Conversations/ConversationsSidebar';
import { ConversationMessages } from '~/components/Conversations/ConversationsMessages';
import { Grid } from '@mantine/core';

// export const getServerSideProps = createServerSideProps({
//   useSSG: true,
//   resolver: async ({ ssg }) => {
//     if (ssg) {
//       await ssg.article.getCivitaiNews.prefetch();
//     }
//   },
// });

// /conversations
// /conversation/:id

export default function ConversationsPage() {
  return (
    <Grid>
      <Grid.Col span={4}>
        <ConversationsSidebar />
      </Grid.Col>
      <Grid.Col span={8}>
        {/* Change this on route? layout routes */}
        <ConversationMessages />
      </Grid.Col>
    </Grid>
  );
}
