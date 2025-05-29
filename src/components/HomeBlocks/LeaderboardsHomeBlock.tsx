import { Button, Card, Divider, Group, Skeleton, Stack, Text } from '@mantine/core';
import { useDebouncedState } from '@mantine/hooks';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconArrowRight, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { Fragment, useCallback, useRef } from 'react';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import { LeaderHomeBlockCreatorItem } from '~/components/HomeBlocks/components/LeaderboardHomeBlockCreatorItem';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { trpc } from '~/utils/trpc';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import clsx from 'clsx';
import classes from './LeaderboardsHomeBlock.module.css';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type Props = { homeBlockId: number; metadata: HomeBlockMetaSchema; showAds?: boolean };

export const LeaderboardsHomeBlock = ({ showAds, ...props }: Props) => {
  return (
    <HomeBlockWrapper py={32}>
      <LeaderboardsHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

export const LeaderboardsHomeBlockContent = ({ homeBlockId, metadata }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery(
    { id: homeBlockId },
    { trpc: { context: { skipBatch: true } } }
  );
  const { columnWidth, columnGap, columnCount } = useMasonryContext();
  const itemCount = homeBlock?.leaderboards?.length ?? 0;
  const [{ atStart, atEnd }, setScrollState] = useDebouncedState<{
    atStart: boolean;
    atEnd: boolean;
  }>({ atStart: true, atEnd: itemCount <= columnCount }, 300);
  const viewportRef = useRef<HTMLDivElement>(null);
  const scroll = useCallback(
    (dir: 'right' | 'left') => {
      if (!viewportRef.current) return;
      const scrollValue = (columnWidth + columnGap) * (dir === 'right' ? 1 : -1) * columnCount;
      const dest = viewportRef.current.scrollLeft + scrollValue;

      let nearestSnap = Math.round(dest / (columnWidth + columnGap)) * (columnWidth + columnGap);
      if (nearestSnap < 0) nearestSnap = 0;
      else if (nearestSnap > viewportRef.current.scrollWidth)
        nearestSnap = viewportRef.current.scrollWidth;

      viewportRef.current.scrollTo({
        left: nearestSnap,
        behavior: 'smooth',
      });
    },
    [viewportRef, columnWidth, columnGap, columnCount]
  );
  const onScroll = useCallback(
    ({ currentTarget }: React.UIEvent<HTMLDivElement>) => {
      const atStart = currentTarget.scrollLeft === 0;
      const atEnd =
        currentTarget.scrollLeft >= currentTarget.scrollWidth - currentTarget.offsetWidth;
      setScrollState({ atStart, atEnd });
    },
    [setScrollState]
  );

  const { leaderboards } = homeBlock ?? {};

  return (
    <Stack gap="xl">
      <div>
        <HomeBlockHeaderMeta metadata={metadata} />
      </div>

      <div className={classes.container}>
        <div className={classes.scrollArea} ref={viewportRef} onScroll={onScroll}>
          <div
            className={classes.grid}
            style={
              {
                '--column-gap': `${columnGap}px`,
                '--column-width': `${columnWidth}px`,
              } as React.CSSProperties
            }
          >
            {isLoading || !leaderboards
              ? Array.from({ length: 14 }).map((_, index) => (
                  <Skeleton key={index} width="100%" height={300} />
                ))
              : leaderboards.map((leaderboard) => {
                  const displayedResults = leaderboard.results.slice(0, 4);

                  return (
                    <Card
                      key={leaderboard.id}
                      radius="md"
                      w="100%"
                      h="100%"
                      style={{ scrollSnapAlign: 'start' }}
                    >
                      <Group justify="space-between" align="center">
                        <Text size="lg">{leaderboard.title}</Text>
                        <Button
                          component={Link}
                          href={`/leaderboard/${leaderboard.id}`}
                          rightSection={<IconArrowRight size={16} />}
                          variant="subtle"
                          size="compact-xs"
                        >
                          More
                        </Button>
                      </Group>
                      <Stack mt="md">
                        {displayedResults.length === 0 && (
                          <Text c="dimmed">
                            No results have been published for this leaderboard
                          </Text>
                        )}
                        {displayedResults.map((result, idx) => {
                          const isLastItem = idx === leaderboard.results.length - 1;

                          return (
                            <Fragment key={idx}>
                              <LeaderHomeBlockCreatorItem leaderboard={leaderboard} data={result} />
                              {!isLastItem && <Divider />}
                            </Fragment>
                          );
                        })}
                      </Stack>
                    </Card>
                  );
                })}
          </div>
        </div>
        <LegacyActionIcon
          className={clsx(classes.nextButton, { [classes.hidden]: atStart })}
          radius="xl"
          size="md"
          color="gray"
          p={4}
          style={{ position: 'absolute', top: '50%', left: 10 }}
          onClick={() => scroll('left')}
        >
          <IconChevronLeft />
        </LegacyActionIcon>
        <LegacyActionIcon
          className={clsx(classes.nextButton, { [classes.hidden]: atEnd })}
          radius="xl"
          size="md"
          color="gray"
          p={4}
          style={{ position: 'absolute', top: '50%', right: 10 }}
          onClick={() => scroll('right')}
        >
          <IconChevronRight />
        </LegacyActionIcon>
      </div>
    </Stack>
  );
};
