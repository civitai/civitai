import { Center, Loader, Stack } from '@mantine/core';
import { Announcements } from '~/components/Announcements/Announcements';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { env } from '~/env/client.mjs';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.article.getEvents.prefetch();
  },
});

export default function EventsPage() {
  const { data, isLoading } = trpc.article.getEvents.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });

  const articles = data?.items ?? [];

  return (
    <>
      <Meta
        title="Civitai Events | Fun AI Art challenges"
        description="Test your AI Art Skills by participating in our community events."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/events`, rel: 'canonical' }]}
      />

      <MasonryContainer>
        <Announcements />
        <Stack spacing="xs">
          {isLoading ? (
            <Center p="xl">
              <Loader size="xl" />
            </Center>
          ) : (
            <MasonryGrid
              data={articles}
              render={ArticleCard}
              itemId={(x) => x.id}
              empty={<NoContent />}
            />
          )}
        </Stack>
      </MasonryContainer>
    </>
  );
}

setPageOptions(EventsPage, { innerLayout: FeedLayout });
