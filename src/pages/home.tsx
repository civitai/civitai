import { Container, Title } from '@mantine/core';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { HomeBlockType } from '@prisma/client';
import CollectionHomeBlock from '~/components/HomeBlocks/CollectionHomeBlock';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';
import AnnouncementHomeBlock from '~/components/HomeBlocks/AnnouncementHomeBlock';
import LeaderboardsHomeBlock from '~/components/HomeBlocks/LeaderboardsHomeBlock';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.alternateHome) return { notFound: true };

    return { props: {} };
  },
});

export default function Home() {
  const { data: homeBlocks = [] } = trpc.homeBlock.getHomeBlocks.useQuery();

  return (
    <Container size="xl">
      <Title order={1}>Home</Title>
      <HomeContentToggle />
      {homeBlocks.map((homeBlock) => {
        switch (homeBlock.type) {
          case HomeBlockType.Collection:
            return <CollectionHomeBlock homeBlock={homeBlock} />;
          case HomeBlockType.Announcement:
            return <AnnouncementHomeBlock homeBlock={homeBlock} />;
          case HomeBlockType.Leaderboard:
            return <LeaderboardsHomeBlock homeBlock={homeBlock} />;
        }
      })}
    </Container>
  );
}
