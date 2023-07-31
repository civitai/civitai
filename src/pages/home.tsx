import { ActionIcon, Center, Container, Group, Loader } from '@mantine/core';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { HomeBlockType } from '@prisma/client';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { AnnouncementHomeBlock } from '~/components/HomeBlocks/AnnouncementHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';
import { IconSettings } from '@tabler/icons-react';
import React from 'react';
import { openContext } from '~/providers/CustomModalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const getServerSideProps = createServerSideProps({
  resolver: async () => {
    // TODO.homepage: always return 404 not found until we migrate new homepage to index
    return { notFound: true };
  },
});

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();
  const user = useCurrentUser();

  return (
    <>
      <Container size="xl" sx={{ overflow: 'hidden' }}>
        <Group position="apart">
          <FullHomeContentToggle />
          {user && (
            <ActionIcon
              size="sm"
              variant="light"
              color="dark"
              onClick={() => openContext('manageHomeBlocks', {})}
              sx={(theme) => ({
                [theme.fn.smallerThan('md')]: {
                  marginLeft: 'auto',
                },
              })}
            >
              <IconSettings />
            </ActionIcon>
          )}
        </Group>
      </Container>

      {isLoading && (
        <Center sx={{ height: 36 }} mt="md">
          <Loader />
        </Center>
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
