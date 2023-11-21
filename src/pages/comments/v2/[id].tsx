import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { threadUrlMap } from '~/server/notifications/comment.notifications';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { id } = ctx.params as { id: string };
    const commentV2 = await dbRead.commentV2.findUnique({
      where: { id: Number(id) },
      select: {
        id: true,
        thread: {
          select: {
            id: true,
            image: {
              select: {
                id: true,
              },
            },
            post: {
              select: {
                id: true,
              },
            },
            review: {
              select: {
                id: true,
              },
            },
            model: {
              select: {
                id: true,
              },
            },
            article: {
              select: {
                id: true,
              },
            },
            bounty: {
              select: {
                id: true,
              },
            },
            bountyEntry: {
              select: {
                id: true,
              },
            },
          },
        },
      },
    });

    if (!commentV2) {
      return { notFound: true };
    }

    const { thread } = commentV2;
    const {
      threadType,
      threadParentId,
    }: { threadType: string | null; threadParentId: number | null } = (() => {
      if (thread.post) {
        return { threadType: 'post', threadParentId: thread.post.id };
      }
      if (thread.review) {
        return { threadType: 'review', threadParentId: thread.review.id };
      }
      if (thread.model) {
        return { threadType: 'model', threadParentId: thread.model.id };
      }
      if (thread.article) {
        return { threadType: 'article', threadParentId: thread.article.id };
      }
      if (thread.bounty) {
        return { threadType: 'bounty', threadParentId: thread.bounty.id };
      }
      if (thread.bountyEntry) {
        return {
          threadType: 'bountyEntry',
          threadParentId: thread.bountyEntry.id,
        };
      }
      if (thread.image) {
        return { threadType: 'image', threadParentId: thread.image.id };
      }

      return { threadType: null, threadParentId: null };
    })();

    if (!threadType || !threadParentId) {
      return { notFound: true };
    }

    const url = threadUrlMap({
      threadParentId,
      threadType,
      threadId: thread.id,
      commentId: commentV2.id,
    });

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
  return <PageLoader text="Redirecting to bounty entry..." />;
}
