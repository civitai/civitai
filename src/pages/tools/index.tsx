import { Stack } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { useFeedSearchQuery } from '~/components/Filters/FeedSearchInput';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ToolsInfinite } from '~/components/Tool/ToolsInfinite';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.toolSearch)
      return {
        redirect: { destination: '/', permanent: false },
      };

    return { props: {} };
  },
});

function ToolsPage() {
  const features = useFeatureFlags();
  // The header bar's search of this page (pageSearch): a name or company match.
  const searchText = useFeedSearchQuery();
  const query = features.pageSearch ? searchText : undefined;

  return (
    <>
      <Meta
        title="Civitai Tools | AI Tools Showcase"
        description="Discover the latest tools used to create generative AI art and explore a gallery of AI-generated art"
        canonical="/tools"
      />
      <MasonryContainer>
        <Stack gap="xs">
          <ToolsInfinite filters={{ query }} />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ToolsPage, { InnerLayout: FeedLayout, announcements: true });
