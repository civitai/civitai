import { useRouter } from 'next/router';
import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { parseBrowsingMode } from '~/server/createContext';
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
  resolver: async ({ ctx, ssg, session = null }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    const postId = Number(params.postId);
    if (!isNumber(postId)) return { notFound: true };

    await ssg?.post.get.prefetch({ id: postId });
    //TODO.Briant - include browsingMode
    await ssg?.image.getInfinite.prefetchInfinite({
      postId,
      browsingMode: parseBrowsingMode(ctx.req.cookies, session),
    });
  },
});
