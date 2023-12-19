import { createServerSideProps } from '~/server/utils/server-side-helpers';
import ConversationsLayout from '~/components/Conversations/ConversationsLayout';
import { ConversationsDefault } from '~/components/Conversations/ConvsationsDefault';

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
      <ConversationsDefault />
    </ConversationsLayout>
  );
}
