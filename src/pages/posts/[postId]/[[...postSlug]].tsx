import { InferGetServerSidePropsType } from 'next';

import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
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
  resolver: async ({ ctx, ssg, browsingLevel }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    const postId = Number(params.postId);
    if (!isNumber(postId)) return { notFound: true };

    await ssg?.post.get.prefetch({ id: postId });
    await ssg?.image.getInfinite.prefetchInfinite({
      postId,
      browsingLevel,
      pending: true,
    });

    return { props: { postId } };
  },
});
