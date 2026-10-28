import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { buildCommentPermalink, getCommentPermalinkRow } from '~/server/utils/comment-permalink';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { id } = ctx.params as { id: string };
    const url = buildCommentPermalink(await getCommentPermalinkRow(Number(id)));

    if (url) {
      return {
        redirect: {
          destination: url,
          permanent: false,
        },
      };
    }

    return { notFound: true };
  },
});

export default function EntriesPage() {
  return <PageLoader text="Redirecting..." />;
}
