import { Center, Container, Loader } from '@mantine/core';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { HomeBlockType } from '@prisma/client';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { AnnouncementHomeBlock } from '~/components/HomeBlocks/AnnouncementHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async () => {
    // TODO.homepage: always return 404 not found until we migrate new homepage to index
    return { notFound: true };
  },
});

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();

  return (
    <>
      <Container size="xl">
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
