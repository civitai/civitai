import { Box, Button, Group, Popover, Text, Title } from '@mantine/core';
import { IconArrowRight, IconInfoCircle } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { AdUnitTop } from '~/components/Ads/AdUnit';
import { FeedLayout } from '~/components/AppLayout/FeedLayout';
import { Page } from '~/components/AppLayout/Page';
import { BrowsingLevelProvider } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CollectionHomeBlock } from '~/components/HomeBlocks/CollectionHomeBlock';
import { CosmeticShopSectionHomeBlock } from '~/components/HomeBlocks/CosmeticShopSectionHomeBlock';
import { EventHomeBlock } from '~/components/HomeBlocks/EventHomeBlock';
import { FeaturedModelVersionHomeBlock } from '~/components/HomeBlocks/FeaturedModelVersionHomeBlock';
import { LeaderboardsHomeBlock } from '~/components/HomeBlocks/LeaderboardsHomeBlock';
import { SocialHomeBlock } from '~/components/HomeBlocks/SocialHomeBlock';
import ImagesInfinite from '~/components/Image/Infinite/ImagesInfinite';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';
import { Meta } from '~/components/Meta/Meta';
import { ModelsInfinite } from '~/components/Model/Infinite/ModelsInfinite';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { env } from '~/env/client';
import { isProd } from '~/env/other';
import { useInView } from '~/hooks/useInView';
import { ImageSort, ModelSort } from '~/server/common/enums';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { HomeBlockType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import classes from './index.module.css';

export function Home() {
  const { data: homeBlocks = [], isLoading: isLoadingHomeBlocks } =
    trpc.homeBlock.getHomeBlocks.useQuery({});
  const { data: homeExcludedTags = [], isLoading: isLoadingExcludedTags } =
    trpc.tag.getHomeExcluded.useQuery(undefined, { trpc: { context: { skipBatch: true } } });

  const [displayModelsInfiniteFeed, setDisplayModelsInfiniteFeed] = useState(false);
  const { ref, inView } = useInView();

  const isLoading = isLoadingHomeBlocks;

  useEffect(() => {
    if (inView && !displayModelsInfiniteFeed) {
      setDisplayModelsInfiniteFeed(true);
    }
  }, [inView, displayModelsInfiniteFeed, setDisplayModelsInfiniteFeed]);

  return (
    <>
      <Meta
        title="Civitai | Discover and Create AI Art"
        description="Explore thousands of free Stable Diffusion & Flux models, create and share AI-generated art, and join the world's largest community of generative AI creators."
        links={[
          { href: `${env.NEXT_PUBLIC_BASE_URL as string}/`, rel: 'canonical' },
          { href: `${env.NEXT_PUBLIC_BASE_URL as string}/home`, rel: 'alternate' },
        ]}
      />

      {isLoading ? (
        <PageLoader />
      ) : (
        <div className={classes.container}>
          <BrowsingLevelProvider browsingLevel={sfwBrowsingLevelsFlag}>
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
                  {homeBlock.type === HomeBlockType.FeaturedModelVersion && (
                    <FeaturedModelVersionHomeBlock
                      homeBlockId={homeBlock.id}
                      metadata={homeBlock.metadata}
                    />
                  )}
                  {showAds && <AdUnitTop className="py-3" />}
                </React.Fragment>
              );
            })}
          </BrowsingLevelProvider>
          <BrowsingLevelProvider browsingLevel={publicBrowsingLevelsFlag}>
            {env.NEXT_PUBLIC_UI_HOMEPAGE_IMAGES ? (
              <Box ref={ref}>
                <MasonryContainer py={32}>
                  {displayModelsInfiniteFeed && !isLoadingExcludedTags && (
                    <IsClient>
                      <Group mb="md" justify="space-between">
                        <Group>
                          <Title className="text-2xl @sm:text-3xl">Images</Title>
                          <Popover withArrow width={380}>
                            <Popover.Target>
                              <Box
                                display="inline-block"
                                style={{ lineHeight: 0.3, cursor: 'pointer' }}
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
                            rightSection={<IconArrowRight size={16} />}
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
                      <Group mb="md" justify="space-between">
                        <Group>
                          <Title className="text-2xl @sm:text-3xl">Models</Title>
                          <Popover withArrow width={380}>
                            <Popover.Target>
                              <Box
                                display="inline-block"
                                style={{ lineHeight: 0.3, cursor: 'pointer' }}
                                color="white"
                              >
                                <IconInfoCircle size={20} />
                              </Box>
                            </Popover.Target>
                            <Popover.Dropdown maw="100%">
                              <Text size="sm" mb="xs">
                                Pre-filtered list of models uploaded by the community that are the
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
                            rightSection={<IconArrowRight size={16} />}
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
          </BrowsingLevelProvider>
        </div>
      )}
    </>
  );
}

export default Page(Home, {
  announcements: true,
  InnerLayout: FeedLayout,
  browsingLevel: publicBrowsingLevelsFlag,
});
