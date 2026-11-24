import type { InferGetServerSidePropsType } from 'next';
import { Page } from '~/components/AppLayout/Page';
import { FeaturePageHost } from '~/components/FeaturePages/FeaturePageHost';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/server';
import {
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
  resolver: async ({ ctx, features }) => {
    if (!features?.featurePages) return { notFound: true };
    const slug = ctx.query.slug;
    if (typeof slug !== 'string' || !featurePageSlugRegex.test(slug)) return { notFound: true };
    const feature = `${FEATURE_PAGES_FEATURE_URN_PREFIX}${slug}`;
    const embed = resolveFeaturePageEmbed(
      env.FEATURE_PAGES_EMBED_URL,
      feature,
      ctx.req.headers.host
    );
    if (!embed || !isFeaturePagesSignerConfigured()) return { notFound: true };
    return { props: { ...embed, feature } };
  },
});

function FeaturePage({
  src,
  origin,
  feature,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta title="Feature" deIndex />
      <FeaturePageHost src={src} origin={origin} feature={feature} />
    </>
  );
}

export default Page(FeaturePage);
