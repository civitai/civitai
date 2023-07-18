import { Center, Container, Loader, Title } from '@mantine/core';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { HomeBlockType } from '@prisma/client';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { AnnouncementHomeBlock } from '~/components/HomeBlocks/AnnouncementHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ssg }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.alternateHome) return { notFound: true };
    if (ssg) await ssg.homeBlock.getHomeBlocks.prefetch();

    return { props: {} };
  },
});

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();

  return (
    <>
      <Container size="xl">
        <Title order={1}>Home</Title>
        <HomeContentToggle />
      </Container>
      {isLoading && (
        <Center sx={{ height: 36 }} mt="md">
          <Loader />
        </Center>
      )}
      {homeBlocks.map((homeBlock) => {
        switch (homeBlock.type) {
          case HomeBlockType.Collection:
            return <CollectionHomeBlock key={homeBlock.id} homeBlock={homeBlock} />;
          case HomeBlockType.Announcement:
            return <AnnouncementHomeBlock key={homeBlock.id} homeBlock={homeBlock} />;
          case HomeBlockType.Leaderboard:
            return <LeaderboardsHomeBlock key={homeBlock.id} homeBlock={homeBlock} />;
        }
      })}
    </>
  );
}
