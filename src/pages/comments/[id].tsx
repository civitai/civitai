import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import type { CommentReadContext } from '~/server/services/commentv3/surfaces';
import { commentSurface } from '~/server/services/commentv3/surfaces';
import { featurePageCommentHref } from '~/server/services/feature-pages/comment-links';
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
    // A Feature Pages comment has no civitai thread. A moderator (every moderator surface links here)
    // is sent to its feature page; anyone else gets the same 404 as for a comment that does not exist.
    if (row?.entityType === 'featurePage') {
      const href = session?.user?.isModerator ? await featurePageCommentHref(row.entityId) : null;
      return href
        ? { redirect: { destination: href, permanent: false } }
        : { notFound: true as const };
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
