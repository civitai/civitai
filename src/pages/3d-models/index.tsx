import { Center, Group, Loader, LoadingOverlay, Stack, Title } from '@mantine/core';
import { IconCube } from '@tabler/icons-react';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { Model3DCard } from '~/components/Cards/Model3DCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

/**
 * 3D Models feed page.
 *
 * Flag gating lives in `getServerSideProps` (returns 404 server-side when the
 * flag is off) so unauthorized viewers never see a flash of content.
 *
 * Phase 2 will wire Meilisearch + filters / sort UI. For v1 this renders the
 * raw Postgres listing from `trpc.model3d.getInfinite` ordered by publishedAt
 * (handled in the service). The service also gates non-mod / non-owner reads
 * to an empty list at the service layer — that's defense-in-depth on top of
 * the flag gate.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.model3dFeed) return { notFound: true };
    return { props: {} };
  },
});

function Model3DsPage() {
  const {
    data,
    isLoading,
    isFetching,
    isRefetching,
    hasNextPage,
    fetchNextPage,
  } = trpc.model3d.getInfinite.useInfiniteQuery(
    { limit: 50 },
    {
      getNextPageParam: (last) => last.nextCursor,
      keepPreviousData: true,
    }
  );

  const items = data?.pages.flatMap((p) => p.items) ?? [];

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
          <Group gap="xs" align="center">
            <IconCube size={28} stroke={1.5} />
            <Title order={1}>3D Models</Title>
          </Group>

          {isLoading ? (
            <Center p="xl">
              <Loader size="xl" />
            </Center>
          ) : items.length ? (
            <div className="relative">
              <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
              <MasonryGridVirtual
                data={items}
                render={Model3DCard}
                itemId={(x) => x.id}
                empty={<NoContent />}
              />
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isFetching}
                  style={{ gridColumn: '1/-1' }}
                >
                  <Center p="xl" style={{ height: 36 }} mt="md">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
              {!hasNextPage && <EndOfFeed />}
            </div>
          ) : (
            <NoContent py="lg" />
          )}
        </Stack>
      </MasonryContainer>
    </>
  );
}

export default Page(Model3DsPage, { InnerLayout: FeedLayout, announcements: true });
