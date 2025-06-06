import { Stack } from '@mantine/core';
import { startCase } from 'lodash-es';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import { useImageQueryParams } from '~/components/Image/image.utils';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { ToolBanner } from '~/components/Tool/ToolBanner';
import { useQueryTools } from '~/components/Tool/tools.utils';
import { env } from '~/env/client';
import { ImageSort } from '~/server/common/enums';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { slugit } from '~/utils/string-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ features, ssg }) => {
    if (!features?.toolSearch) return { notFound: true };

    await ssg?.tool.getAll.prefetchInfinite();

    return { props: {} };
  },
});

function ToolFeedPage() {
  const router = useRouter();

  const { slug } = router.query;
  const { query } = useImageQueryParams();
  const {
    period = MetricTimeframe.AllTime,
    sort = ImageSort.MostReactions,
    baseModels,
    techniques,
    fromPlatform,
    hidden,
    followed,
    notPublished,
    scheduled,
    withMeta,
  } = query;

  const { tools, loading } = useQueryTools({ filters: { include: ['unlisted'] } });
  const toolId = tools.find((tool) => slugit(tool.name) === slug)?.id;

  if (loading) return <PageLoader />;
  if (!loading && !toolId) return <NotFound />;

  return (
    <>
      <Meta
        title="Civitai Gallery | AI-Generated Art Showcase"
        description={`See the latest art created with ${startCase(
          slug as string
        )} by the generative AI art community and delve into the inspirations and prompts behind their work`}
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/tools/${slug}`, rel: 'canonical' }]}
      />
      <ToolBanner slug={slug as string} />
      <BrowsingLevelProvider browsingLevel={publicBrowsingLevelsFlag}>
        <MasonryContainer>
          <Stack gap="xs">
            <IsClient>
              <ImageCategories />
              <ImagesInfinite
                filters={{
                  period,
                  sort,
                  baseModels,
                  techniques,
                  fromPlatform,
                  hidden,
                  followed,
                  notPublished,
                  scheduled,
                  withMeta,
                  tools: toolId ? [toolId] : undefined,
                  types: ['image', 'video'],
                }}
                showEof
                showAds
                useIndex
                disableStoreFilters
              />
            </IsClient>
          </Stack>
        </MasonryContainer>
      </BrowsingLevelProvider>
    </>
  );
}

export default Page(ToolFeedPage, { InnerLayout: FeedLayout, announcements: true });
