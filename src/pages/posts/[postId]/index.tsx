import { useRouter } from 'next/router';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { isNumber } from '~/utils/type-guards';

export default function PostDetailPage() {
  const router = useRouter();
  const postId = Number(router.query.postId);

  return (
    <>
      <PostDetail postId={postId} />
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    const postId = Number(params.postId);
    if (!isNumber(postId)) return { notFound: true };

    await ssg?.post.get.prefetch({ id: postId });
    await ssg?.image.getInfinite.prefetchInfinite({ postId });
  },
});
