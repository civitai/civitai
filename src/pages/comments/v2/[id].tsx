import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { buildCommentPermalink } from '~/server/utils/comment-permalink';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx }) => {
    const { id } = ctx.params as { id: string };
    const select = {
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
      challenge: {
        select: {
          id: true,
        },
      },
      comicChapter: {
        select: {
          projectId: true,
        },
      },
      // The one SLUG-addressed thread parent. `appListingId` is `app_listings.serial_id`, an
      // integer surrogate that appears nowhere in the URL, so the slug is what has to be
      // selected here — see `buildCommentPermalink`.
      appListing: {
        select: {
          slug: true,
        },
      },
    };
    const commentV2 = await dbRead.commentV2.findUnique({
      where: { id: Number(id) },
      select: {
        id: true,
        thread: {
          select: {
            id: true,
            rootThread: {
              select: {
                id: true,
                ...select,
              },
            },
            comment: {
              select: {
                id: true,
              },
            },
            ...select,
          },
        },
      },
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
