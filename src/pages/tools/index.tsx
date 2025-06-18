import { Stack } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ToolsInfinite } from '~/components/Tool/ToolsInfinite';
import { env } from '~/env/client';
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
  return (
    <>
      <Meta
        title="Civitai Tools | AI Tools Showcase"
        description="Discover the latest tools used to create generative AI art and explore a gallery of AI-generated art"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/tools`, rel: 'canonical' }]}
      />
      <MasonryContainer>
        <Stack gap="xs">
          <ToolsInfinite />
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(ToolsPage, { InnerLayout: FeedLayout, announcements: true });
