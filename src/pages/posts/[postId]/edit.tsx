import { PostEditLayout } from '~/components/Post/EditV2/PostEditLayout';
import { PostEdit } from '~/components/Post/EditV2/PostEdit';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import * as z from 'zod/v4';
import { getDbWithoutLag } from '~/server/db/db-helpers';
import { Meta } from '~/components/Meta/Meta';
import { Page } from '~/components/AppLayout/Page';

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
    const db = await getDbWithoutLag('post', postId);
    const post = await db.post.findUnique({ where: { id: postId }, select: { userId: true } });
    const isOwner = post?.userId === session.user?.id;
    if (!isOwner && !session.user?.isModerator) return { notFound: true };

    return { props: { postId } };
  },
});

export default Page(
  function () {
    return (
      <>
        <Meta deIndex />
        <div className="container max-w-lg">
          <PostEdit />
        </div>
      </>
    );
  },
  { InnerLayout: PostEditLayout }
);
