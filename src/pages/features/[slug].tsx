import type { InferGetServerSidePropsType } from 'next';
import { Page } from '~/components/AppLayout/Page';
import { FeaturePageHost } from '~/components/FeaturePages/FeaturePageHost';
import { Meta } from '~/components/Meta/Meta';
import { getFeaturePageProps } from '~/server/services/feature-pages.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: getFeaturePageProps,
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
