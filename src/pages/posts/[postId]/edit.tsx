import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostEdit } from '~/components/Post/EditV2/PostEdit';
import { createPage } from '~/components/AppLayout/createPage';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { dbRead } from '~/server/db/client';
import { z } from 'zod';

const paramsSchema = z.object({
  postId: z.coerce.number(),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    const parsedParams = paramsSchema.safeParse(ctx.params);
    if (!parsedParams.success) return { notFound: true };

    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'post-images' }),
          permanent: false,
        },
      };
    }

    const postId = parsedParams.data.postId;
    const post = await dbRead.post.findUnique({ where: { id: postId }, select: { userId: true } });
    const isOwner = post?.userId === session.user?.id;
    if (!isOwner && !session.user?.isModerator) return { notFound: true };

    return { props: { postId } };
  },
});

export default createPage(
  function PostEditPage() {
    return (
      <div className="container max-w-lg">
        <PostEdit />
      </div>
    );
  },
  { InnerLayout: PostEditLayout }
);
