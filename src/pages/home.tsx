import { Box, Button, Center, Group, Loader, Popover, Text, Title } from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { HomeBlockType, MetricTimeframe } from '@prisma/client';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';
import { IconArrowRight, IconInfoCircle } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { useInView } from '~/hooks/useInView';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { constants } from '~/server/common/constants';
import { MasonryProvider } from '~/components/MasonryColumns/MasonryProvider';
import { ImageSort, ModelSort } from '~/server/common/enums';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { SocialHomeBlock } from '~/components/HomeBlocks/SocialHomeBlock';
import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client.mjs';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { EventHomeBlock } from '~/components/HomeBlocks/EventHomeBlock';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { BrowsingModeOverrideProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { isProd } from '~/env/other';
import { AdUnit } from '~/components/Ads/AdUnit';
import { CosmeticShopSectionHomeBlock } from '~/components/HomeBlocks/CosmeticShopSectionHomeBlock';

export default function Home() {
  const { data: homeBlocks = [], isLoading } = trpc.homeBlock.getHomeBlocks.useQuery();
  const { data: homeExcludedTags = [], isLoading: isLoadingExcludedTags } =
    trpc.tag.getHomeExcluded.useQuery(undefined, { trpc: { context: { skipBatch: true } } });

  const [displayModelsInfiniteFeed, setDisplayModelsInfiniteFeed] = useState(false);
  const { ref, inView } = useInView();

  useEffect(() => {
    if (inView && !displayModelsInfiniteFeed) {
      setDisplayModelsInfiniteFeed(true);
    }
  }, [inView, displayModelsInfiniteFeed, setDisplayModelsInfiniteFeed]);

  return (
    <>
      <Meta
        title="Civitai: The Home of Open-Source Generative AI"
        description="Explore thousands of high-quality Stable Diffusion & Flux models, share your AI-generated art, and engage with a vibrant community of creators"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/`, rel: 'canonical' }]}
      />
      <MasonryProvider
        columnWidth={constants.cardSizes.model}
        maxColumnCount={7}
        maxSingleColumnWidth={450}
      >
        {/* <MasonryContainer px={0} sx={{ overflow: 'hidden' }}>
          <Adunit mt="md" mb="xs" {...adsRegistry.homePageHeader} />
        </MasonryContainer> */}

        {isLoading && (
          <Center sx={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        )}

        <Box
          className="-mt-3"
          sx={(theme) => ({
            '& > *:nth-of-type(even)': {
              background:
                theme.colorScheme === 'dark'
                  ? theme.colors.dark[8]
                  : theme.fn.darken(theme.colors.gray[0], 0.01),
            },
          })}
        >
          <BrowsingModeOverrideProvider browsingLevel={sfwBrowsingLevelsFlag}>
            {homeBlocks.map((homeBlock, i) => {
              const showAds = i % 2 === 1 && i > 0;
              return (
                <React.Fragment key={homeBlock.id}>
                  {homeBlock.type === HomeBlockType.Collection && (
                    <CollectionHomeBlock homeBlockId={homeBlock.id} metadata={homeBlock.metadata} />
                  )}
                  {/* {homeBlock.type === HomeBlockType.Announcement && (
                    <AnnouncementHomeBlock homeBlockId={homeBlock.id} />
                  )} */}
                  {homeBlock.type === HomeBlockType.Leaderboard && (
                    <LeaderboardsHomeBlock
                      homeBlockId={homeBlock.id}
                      metadata={homeBlock.metadata}
                    />
                  )}
                  {homeBlock.type === HomeBlockType.Social && (
                    <SocialHomeBlock metadata={homeBlock.metadata} />
                  )}
                  {homeBlock.type === HomeBlockType.Event && (
                    <EventHomeBlock metadata={homeBlock.metadata} />
                  )}
                  {homeBlock.type === HomeBlockType.CosmeticShop && (
                    <CosmeticShopSectionHomeBlock
                      metadata={homeBlock.metadata}
                      homeBlockId={homeBlock.id}
                    />
                  )}
                  {showAds && (
                    <AdUnit className="justify-center p-3" keys={['Dynamic_Leaderboard']} />
                  )}
                </React.Fragment>
              );
            })}
          </BrowsingModeOverrideProvider>
          <BrowsingModeOverrideProvider browsingLevel={publicBrowsingLevelsFlag}>
            {env.NEXT_PUBLIC_UI_HOMEPAGE_IMAGES ? (
              <Box ref={ref}>
                <MasonryContainer py={32}>
                  {displayModelsInfiniteFeed && !isLoadingExcludedTags && (
                    <IsClient>
                      <Group mb="md" position="apart">
                        <Group>
                          <Title
                            sx={(theme) => ({
                              fontSize: 32,

                              [containerQuery.smallerThan('sm')]: {
                                fontSize: 24,
                              },
                            })}
                          >
                            Images
                          </Title>
                          <Popover withArrow width={380}>
                            <Popover.Target>
                              <Box
                                display="inline-block"
                                sx={{ lineHeight: 0.3, cursor: 'pointer' }}
                                color="white"
                              >
                                <IconInfoCircle size={20} />
                              </Box>
                            </Popover.Target>
                            <Popover.Dropdown maw="100%">
                              <Text size="sm" mb="xs">
                                Pre-filtered list of the highest rated images post by the community
                                over the last week
                              </Text>
                            </Popover.Dropdown>
                          </Popover>
                        </Group>

                        <Link legacyBehavior href="/images" passHref>
                          <Button
                            h={34}
                            component="a"
                            variant="subtle"
                            rightIcon={<IconArrowRight size={16} />}
                          >
                            View all
                          </Button>
                        </Link>
                      </Group>

                      <ImagesInfinite
                        showAds
                        filters={{
                          // Required to override localStorage filters
                          period: MetricTimeframe.Week,
                          sort: ImageSort.MostReactions,
                          types: undefined,
                          hidden: undefined,
                          followed: false,
                          withMeta: true,
                        }}
                      />
                    </IsClient>
                  )}
                </MasonryContainer>
              </Box>
            ) : (
              <Box ref={ref}>
                <MasonryContainer py={32}>
                  {displayModelsInfiniteFeed && !isLoadingExcludedTags && (
                    <IsClient>
                      <Group mb="md" position="apart">
                        <Group>
                          <Title
                            sx={(theme) => ({
                              fontSize: 32,

                              [containerQuery.smallerThan('sm')]: {
                                fontSize: 24,
                              },
                            })}
                          >
                            Models
                          </Title>
                          <Popover withArrow width={380}>
                            <Popover.Target>
                              <Box
                                display="inline-block"
                                sx={{ lineHeight: 0.3, cursor: 'pointer' }}
                                color="white"
                              >
                                <IconInfoCircle size={20} />
                              </Box>
                            </Popover.Target>
                            <Popover.Dropdown maw="100%">
                              <Text size="sm" mb="xs">
                                Pre-filtered list of models upload by the community that are the
                                highest rated over the last week
                              </Text>
                            </Popover.Dropdown>
                          </Popover>
                        </Group>

                        <Link legacyBehavior href="/models" passHref>
                          <Button
                            h={34}
                            component="a"
                            variant="subtle"
                            rightIcon={<IconArrowRight size={16} />}
                          >
                            View all
                          </Button>
                        </Link>
                      </Group>

                      <ModelsInfinite
                        showAds
                        disableStoreFilters
                        filters={{
                          // excludedImageTagIds: homeExcludedTags.map((tag) => tag.id),
                          excludedTagIds: homeExcludedTags.map((tag) => tag.id),
                          // Required to override localStorage filters
                          period: isProd ? MetricTimeframe.Week : MetricTimeframe.AllTime,
                          sort: ModelSort.HighestRated,
                          types: undefined,
                          collectionId: undefined,
                          earlyAccess: false,
                          status: undefined,
                          checkpointType: undefined,
                          baseModels: undefined,
                          hidden: undefined,
                        }}
                      />
                    </IsClient>
                  )}
                </MasonryContainer>
              </Box>
            )}
          </BrowsingModeOverrideProvider>
        </Box>
      </MasonryProvider>
    </>
  );
}
