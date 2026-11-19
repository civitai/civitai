import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import type { CommentReadContext } from '~/server/services/commentv3/surfaces';
import { commentSurface } from '~/server/services/commentv3/surfaces';
import { buildCommentPermalink, getCommentPermalinkRow } from '~/server/utils/comment-permalink';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, session, features }) => {
    const { id } = ctx.params as { id: string };
    const row = await getCommentPermalinkRow(Number(id), {
      includeHidden: !!session?.user?.isModerator,
    });
    // A text's thread is readable only where its text is; the redirect must not say which exist.
    if (row?.entityType === 'postText') {
      const readCtx = { user: session?.user, features, req: ctx.req } as CommentReadContext;
      const visible = await commentSurface('postText')
        .assertVisible?.(row.entityId, readCtx)
        .then(() => true)
        .catch(() => false);
      if (!visible) return { notFound: true };
    }
    const url = buildCommentPermalink(row);

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
