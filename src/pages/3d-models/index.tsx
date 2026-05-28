import { Card, Center, Stack, Text, Title } from '@mantine/core';
import { IconCube } from '@tabler/icons-react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

/**
 * 3D Models feed page (Workstream D stub).
 *
 * The real feed (Meilisearch-backed, categories, infinite scroll) is filled in
 * by Phase 2. For now this is a placeholder so the route resolves while the
 * feature flag is mod-only.
 *
 * Flag gating lives in `getServerSideProps` (returns 404 server-side when the
 * flag is off) so unauthorized viewers never see a flash of content. The
 * client-side `<NotFound />` check we used to have caused a flicker between
 * SSR hydration and FeatureFlagsProvider's user-features query resolving.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.model3dFeed) return { notFound: true };
    return { props: {} };
  },
});

function Model3DsPage() {
  return (
    <>
      <Meta
        title="3D Models | Civitai"
        description="Browse 3D models generated and shared by the Civitai community."
        canonical="/3d-models"
        deIndex
      />

      <MasonryContainer>
        <Stack gap="md">
          <Title order={1}>3D Models</Title>
          <Card withBorder radius="md" p="xl">
            <Center>
              <Stack align="center" gap="sm" maw={520} ta="center">
                <IconCube size={48} stroke={1.5} />
                <Title order={3}>3D Models Feed (coming soon)</Title>
                <Text c="dimmed" size="sm">
                  We&apos;re building out the 3D Models experience. Soon you&apos;ll be able to
                  browse generated and uploaded 3D models, view them in your browser, and download
                  in your format of choice.
                </Text>
              </Stack>
            </Center>
          </Card>
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(Model3DsPage, { InnerLayout: FeedLayout, announcements: true });
