import { useRouter } from 'next/router';
import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export default function PostDetailPage() {
  const router = useRouter();
  const postId = Number(router.query.postId);

  return (
    <>
      {/* This may not need to be a separate component. Depends on if we ever want a post to open in stacked navigation (routed modal) */}
      <PostDetail postId={postId} />
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    console.log({ params });
    const postId = Number(params.postId);
    if (!isNumber(postId)) return { notFound: true };

    await ssg?.post.get.prefetch({ id: postId });
    await ssg?.image.getInfinite.prefetch({ postId });
  },
});
