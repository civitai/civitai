import { Stack } from '@mantine/core';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { BrowsingModeOverrideProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageCategories } from '~/components/Image/Filters/ImageCategories';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ToolBanner } from '~/components/Tool/ToolBanner';
import { env } from '~/env/client.mjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { slugit } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ features, ssg }) => {
    if (!features?.toolSearch) return { notFound: true };

    await ssg?.tool.getAll.prefetch();

    return { props: {} };
  },
});

function ToolFeedPage() {
  const router = useRouter();

  const { slug } = router.query;

  const { data = [] } = trpc.tool.getAll.useQuery();
  const toolId = data.find((tool) => slugit(tool.name) === slug)?.id;

  if (!toolId) return <NotFound />;

  return (
    <>
      <Meta
        title="Civitai Gallery | AI-Generated Art Showcase"
        description="See the latest art created by the generative AI art community and delve into the inspirations and prompts behind their work"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/tools/${slug}`, rel: 'canonical' }]}
      />
      <ToolBanner slug={slug as string} />
      <BrowsingModeOverrideProvider browsingLevel={publicBrowsingLevelsFlag}>
        <MasonryContainer>
          <Stack spacing="xs">
            <IsClient>
              <ImageCategories />
              <ImagesInfinite
                filters={{ tools: toolId ? [toolId] : undefined }}
                showEof
                showAds
                useIndex
              />
            </IsClient>
          </Stack>
        </MasonryContainer>
      </BrowsingModeOverrideProvider>
    </>
  );
}

export default Page(ToolFeedPage, { InnerLayout: FeedLayout, announcements: true });
