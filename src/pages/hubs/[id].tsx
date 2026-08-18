import { Center, Group, Loader, Text, Title } from '@mantine/core';
import { useRouter } from 'next/router';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ImageSort } from '~/server/common/enums';
import { hubSortSchema } from '~/server/schema/user-hub.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session?.user) return { redirect: { destination: '/login', permanent: false } };
  },
});

export default Page(
  function HubFeedPage() {
    const router = useRouter();
    const hubId = Number(router.query.id);

    const { data: hub, isLoading } = trpc.userHub.getById.useQuery(
      { id: hubId },
      { enabled: Number.isInteger(hubId) }
    );

    if (isLoading)
      return (
        <Center py="xl">
          <Loader />
        </Center>
      );
    if (!hub) return <NotFound />;

    const hasSources = hub.sources.some((s) => s.enabled);

    return (
      <>
        <Meta title={`${hub.name} | Civitai`} deIndex />
        <MasonryContainer className="min-h-full">
          <div className="flex flex-col gap-2.5">
            <Group justify="space-between">
              <Title order={1}>{hub.name}</Title>
            </Group>
            {!hasSources ? (
              <Text c="dimmed">
                This hub has no active sources yet. Add a creator, model or collection to start
                filling it.
              </Text>
            ) : (
              // disableStoreFilters keeps the global image-filter store out of a hub:
              // the hub's own sort and period are what the user configured for it.
              <ImagesInfinite
                showEof
                disableStoreFilters
                filters={{
                  hubId: hub.id,
                  // `sort` is a plain column, so a value written before the enum
                  // narrowed (or by hand) would otherwise reach the query as-is.
                  sort: hubSortSchema.catch(ImageSort.Newest).parse(hub.sort),
                  period: hub.period,
                }}
              />
            )}
          </div>
        </MasonryContainer>
      </>
    );
  },
  { InnerLayout: FeedLayout }
);
