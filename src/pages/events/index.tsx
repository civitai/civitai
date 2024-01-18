import { createStyles, Stack, useMantineTheme, Center, Loader, Group } from '@mantine/core';

import { Announcements } from '~/components/Announcements/Announcements';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { env } from '~/env/client.mjs';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.article.getEvents.prefetch();
  },
});

export default function EventsPage() {
  const features = useFeatureFlags();
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
      <MasonryProvider
        columnWidth={constants.cardSizes.image}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid>
          <Stack spacing="xs">
            <Announcements
              sx={(theme) => ({
                marginBottom: -35,
                [containerQuery.smallerThan('md')]: {
                  marginBottom: -5,
                },
              })}
            />
            <Group position="apart" spacing={8}>
              {features.alternateHome ? <FullHomeContentToggle /> : <HomeContentToggle />}
            </Group>

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
      </MasonryProvider>
    </>
  );
}
