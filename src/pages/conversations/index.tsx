import { createServerSideProps } from '~/server/utils/server-side-helpers';
import ConversationsLayout from '~/components/Conversations/ConversationsLayout';

// export const getServerSideProps = createServerSideProps({
//   useSSG: true,
//   resolver: async ({ ssg }) => {
//     if (ssg) {
//       await ssg.article.getCivitaiNews.prefetch();
//     }
//   },
// });

export default function ConversationsPage() {
  return (
    <ConversationsLayout>
      <h1>Default Convo copy</h1>
    </ConversationsLayout>
  );
}
