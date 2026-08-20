import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { buildCommentPermalink, commentPermalinkSelect } from '~/server/utils/comment-permalink';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { id } = ctx.params as { id: string };

    // The select lives beside the resolver that reads it (`comment-permalink.ts`) rather than
    // here, so the two cannot drift: the payload type is derived FROM this select, and the
    // resolver's parameter type is derived from that payload. Narrow the select and the resolver
    // stops compiling — which is the only thing that catches a select-correctness bug, since a
    // mocked `dbRead` would just encode the same mistake in the fake.
    const commentV2 = await dbRead.commentV2.findUnique({
      where: { id: Number(id) },
      select: commentPermalinkSelect,
    });

    if (!commentV2) {
      return { notFound: true };
    }

    const url = buildCommentPermalink({ thread: commentV2.thread, commentId: commentV2.id });

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
