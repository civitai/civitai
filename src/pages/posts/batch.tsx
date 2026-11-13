import { useRouter } from 'next/router';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { BatchComposer } from '~/components/Post/Batch/BatchComposer';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { postEditQuerySchema } from '~/server/schema/post.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'post-images' }),
          permanent: false,
        },
      };
    if (!features?.batchPostScheduling) return { notFound: true };
  },
});

const batchQuerySchema = postEditQuerySchema.extend({
  startAt: z.coerce.date().optional().catch(undefined),
});

export default Page(function BatchPostsPage() {
  const features = useFeatureFlags();
  const router = useRouter();
  if (!features.batchPostScheduling) return <NotFound />;
  const { modelId, modelVersionId, startAt } = batchQuerySchema.parse(router.query);
  return <BatchComposer modelId={modelId} modelVersionId={modelVersionId} startAt={startAt} />;
});
