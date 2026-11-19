import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MusicFeedPage } from '~/components/Music/MusicFeedPage';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  resolver: async ({ features }) => {
    if (!features?.music) return { notFound: true };
    return { props: {} };
  },
});

export default Page(MusicFeedPage, { InnerLayout: FeedLayout, announcements: true });
