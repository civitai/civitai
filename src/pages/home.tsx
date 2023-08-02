import { ActionIcon, Box, Center, Group, Loader, Title } from '@mantine/core';
import { FullHomeContentToggle } from '~/components/HomeContentToggle/FullHomeContentToggle';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';
import { HomeBlockType, MetricTimeframe } from '@prisma/client';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { AnnouncementHomeBlock } from '~/components/HomeBlocks/AnnouncementHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';
import { IconSettings } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { openContext } from '~/providers/CustomModalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from 'react-intersection-observer';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { constants } from '~/server/common/constants';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ModelSort } from '~/server/common/enums';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';

export const getServerSideProps = createServerSideProps({
  resolver: async () => {
    // TODO.homepage: always return 404 not found until we migrate new homepage to index
    return { notFound: true };
  },
});

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();
  const { data: homeExcludedTags = [], isLoading: isLoadingExcludedTags } =
    trpc.tag.getHomeExcluded.useQuery();

  const [displayModelsInfiniteFeed, setDisplayModelsInfiniteFeed] = useState(false);
  const { ref, inView } = useInView();
  const user = useCurrentUser();

  useEffect(() => {
    if (inView && !displayModelsInfiniteFeed) {
      setDisplayModelsInfiniteFeed(true);
    }
  }, [inView, displayModelsInfiniteFeed, setDisplayModelsInfiniteFeed]);

  return (
    <>
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        <MasonryContainer fluid sx={{ overflow: 'hidden' }}>
          <Group position="apart" noWrap>
            <FullHomeContentToggle />
            {user && (
              <ActionIcon
                size="sm"
                variant="light"
                color="dark"
                onClick={() => openContext('manageHomeBlocks', {})}
              >
                <IconSettings />
              </ActionIcon>
            )}
          </Group>
        </MasonryContainer>

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

        <Box ref={ref}>
          <HomeBlockWrapper py={32}>
            {displayModelsInfiniteFeed && !isLoadingExcludedTags && (
              <IsClient>
                <Box
                  sx={(theme) => ({
                    paddingLeft: theme.spacing.md,
                    paddingRight: theme.spacing.md,

                    [theme.fn.smallerThan('sm')]: {
                      paddingLeft: 0,
                      paddingRight: 0,
                    },
                  })}
                >
                  <Title
                    sx={(theme) => ({
                      fontSize: theme.headings.sizes.h1.fontSize,
                      [theme.fn.smallerThan('md')]: {
                        fontSize: theme.headings.sizes.h3.fontSize,
                      },
                    })}
                  >
                    Models
                  </Title>

                  <ModelsInfinite
                    filters={{
                      period: MetricTimeframe.Month,
                      sort: ModelSort.HighestRated,
                      excludedImageTagIds: homeExcludedTags.map((tag) => tag.id),
                    }}
                  />
                </Box>
              </IsClient>
            )}
          </HomeBlockWrapper>
        </Box>
      </MasonryProvider>
    </>
  );
}
