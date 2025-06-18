import { Center, Loader, Stack } from '@mantine/core';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { ArticleCard } from '~/components/Cards/ArticleCard';
import { ChallengeHero } from '~/components/Challenges/ChallengeHero';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { Meta } from '~/components/Meta/Meta';
import { NoContent } from '~/components/NoContent/NoContent';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ssg }) => {
    await ssg?.dailyChallenge.getAll.prefetch();
  },
});

function ChallengesPage() {
  const { data, isLoading } = trpc.dailyChallenge.getAll.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });

  const challenges = data?.items ?? [];

  return (
    <>
      <Meta
        title="Civitai Challenges | Fun AI Art challenges"
        description="Test your AI Art Skills by participating in our community challenges."
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/events`, rel: 'canonical' }]}
      />
      <ChallengeHero />
      <MasonryContainer>
        <Stack gap="xs">
          {isLoading ? (
            <Center p="xl">
              <Loader size="xl" />
            </Center>
          ) : (
            <MasonryGrid
              data={challenges}
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

export default Page(ChallengesPage, { InnerLayout: FeedLayout, announcements: true });
