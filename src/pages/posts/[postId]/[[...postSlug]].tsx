import type { InferGetServerSidePropsType } from 'next';

import { ClientOnlySectionsProvider } from '~/components/ClientOnlySection/ClientOnlySection';
import { PostDetail } from '~/components/Post/Detail/PostDetail';
import { hasEntityAccess } from '~/server/services/common.service';
import { getPostDetail } from '~/server/services/post.service';
import { getServerBrowsingLevel, getServerImageQueryFilters } from '~/server/utils/browsing-level';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ssrClientOnlySectionsOn } from '~/server/utils/ssr-client-only-sections';
import { Availability } from '~/shared/utils/prisma/enums';
import { isNotFoundError, isPageId, rethrowSsrError } from '~/server/utils/ssr-not-found';

export default function PostDetailPage({
  postId,
  ssrClientOnlySections,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <ClientOnlySectionsProvider enabled={ssrClientOnlySections}>
      {/* This may not need to be a separate component. Depends on if we ever want a post to open in stacked navigation (routed modal) */}
      <PostDetail postId={postId} />
    </ClientOnlySectionsProvider>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ctx, ssg, session, features }) => {
    const params = (ctx.params ?? {}) as { postId: string };
    const postId = Number(params.postId);
    if (!isPageId(postId)) return { notFound: true };
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
      const imageFilters = await getServerImageQueryFilters(
        getServerBrowsingLevel({
          canViewNsfw: features?.canViewNsfw ?? false,
          user: session?.user,
        }),
        { isModerator: session?.user?.isModerator }
      );
      if (imageFilters)
        await ssg?.image.getInfinite.prefetchInfinite({
          postId,
          pending: !!session?.user,
          withMeta: false,
          include: [],
          ...imageFilters,
        });
      await ssg?.post.getContestCollectionDetails.prefetch({ id: postId });
      await ssg?.hiddenPreferences.getHidden.prefetch();

      // PostDetail gates on `forcedBrowsingLevel || nsfwLevel`; the forced level comes from
      // contest-collection details the client only resolves after hydration.
      return {
        props: { postId, ssrClientOnlySections: ssrClientOnlySectionsOn() },
        gating: {
          contentNsfwLevel: post.nsfwLevel,
          nsfw: post.nsfw,
        },
        suppressAds: !post.publishedAt,
      };
    } catch (error) {
      // Only a missing post is a 404; a failed lookup must not tell anyone the post does not exist.
      if (isNotFoundError(error)) return { notFound: true };
      console.error('Error fetching post detail:', error);
      rethrowSsrError(ctx.res, error);
    }
  },
});
