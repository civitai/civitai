import { Button, Center, Container, Loader } from '@mantine/core';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { HomeBlockType } from '@prisma/client';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { AnnouncementHomeBlock } from '~/components/HomeBlocks/AnnouncementHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';
import { openContext } from '~/providers/CustomModalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMemo } from 'react';

export const getServerSideProps = createServerSideProps({
  resolver: async () => {
    // TODO.homepage: always return 404 not found until we migrate new homepage to index
    return { notFound: true };
  },
});

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();
  const user = useCurrentUser();
  const hasUserHomeBlocks = useMemo(() => {
    if (!user) {
      return false;
    }

    return homeBlocks.find((homeBlock) => homeBlock.userId === user.id);
  }, [user, homeBlocks]);

  return (
    <>
      <Container size="xl" sx={{ overflow: 'hidden' }}>
        <FullHomeContentToggle />
      </Container>
      {isLoading && (
        <Center sx={{ height: 36 }} mt="md">
          <Loader />
        </Center>
      )}
      {/*TODO.PersonalizedHomePage: Complete this flow. */}
      {hasUserHomeBlocks && false && (
        <Button
          onClick={() => {
            openContext('manageHomeBlocks', {});
          }}
        >
          Manage home
        </Button>
      )}
      {homeBlocks.map((homeBlock) => {
        switch (homeBlock.type) {
          case HomeBlockType.Collection:
            return <CollectionHomeBlock key={homeBlock.id} homeBlockId={homeBlock.id} />;
          case HomeBlockType.Announcement:
            return <AnnouncementHomeBlock key={homeBlock.id} homeBlockId={homeBlock.id} />;
          case HomeBlockType.Leaderboard:
            return <LeaderboardsHomeBlock key={homeBlock.id} homeBlockId={homeBlock.id} />;
        }
      })}
    </>
  );
}
