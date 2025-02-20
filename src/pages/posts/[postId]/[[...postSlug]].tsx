import { InferGetServerSidePropsType } from 'next';

import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { hasEntityAccess } from '~/server/services/common.service';
import { getPostDetail } from '~/server/services/post.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Availability } from '~/shared/utils/prisma/enums';
import { isNumber } from '~/utils/type-guards';

export default function PostDetailPage({
  postId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      {/* This may not need to be a separate component. Depends on if we ever want a post to open in stacked navigation (routed modal) */}
      <PostDetail postId={postId} />
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, session }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    const postId = Number(params.postId);
    if (!isNumber(postId)) return { notFound: true };
    try {
      const post = await getPostDetail({ id: postId, user: session?.user });

      if (!post) return { notFound: true };

      if (post.availability === Availability.Private) {
        // Confirm access:
        if (!session?.user) return { notFound: true };

        const [access] = await hasEntityAccess({
          userId: session.user.id,
          isModerator: session.user.isModerator,
          entityIds: [postId],
          entityType: 'Post',
        });

        if (!access || !access.hasAccess) return { notFound: true };
      }

      await ssg?.post.get.prefetch({ id: postId });
      await ssg?.image.getInfinite.prefetchInfinite({
        postId,
        pending: !!session?.user,
      });
      await ssg?.post.getContestCollectionDetails.prefetch({ id: postId });
      await ssg?.hiddenPreferences.getHidden.prefetch();

      return { props: { postId } };
    } catch (error) {
      console.error('Error fetching post detail:', error);
      return { notFound: true };
    }
  },
});
