import type { InferGetServerSidePropsType } from 'next';
import { Page } from '~/components/AppLayout/Page';
import { FeaturePageHost } from '~/components/FeaturePages/FeaturePageHost';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/server';
import {
  getFeaturePageViewerHandle,
  isFeaturePagesSignerConfigured,
  resolveFeaturePageEmbed,
} from '~/server/services/feature-pages.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  FEATURE_PAGES_FEATURE_URN_PREFIX,
  featurePageSlugRegex,
} from '~/shared/constants/feature-pages.constants';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, features, session }) => {
    // The frame's props depend on the request, so no cache may hold the page for another viewer.
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    if (!features?.featurePages) return { notFound: true };
    const slug = ctx.query.slug;
    if (typeof slug !== 'string' || !featurePageSlugRegex.test(slug)) return { notFound: true };
    const feature = `${FEATURE_PAGES_FEATURE_URN_PREFIX}${slug}`;
    const embed = resolveFeaturePageEmbed(env.FEATURE_PAGES_EMBED_URL, feature);
    if (!embed || !isFeaturePagesSignerConfigured()) return { notFound: true };
    const viewerAuthor = session?.user ? await getFeaturePageViewerHandle(session.user.id) : null;
    return { props: { ...embed, feature, viewerAuthor } };
  },
});

function FeaturePage({
  src,
  origin,
  feature,
  viewerAuthor,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta title="Feature" deIndex />
      <FeaturePageHost src={src} origin={origin} feature={feature} viewerAuthor={viewerAuthor} />
    </>
  );
}

export default Page(FeaturePage);
