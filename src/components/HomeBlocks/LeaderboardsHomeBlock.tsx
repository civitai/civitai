import {
  ActionIcon,
  Button,
  Card,
  Divider,
  Group,
  Stack,
  Text,
  createStyles,
  ScrollArea,
} from '@mantine/core';
import { IconArrowRight, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useEffect, useRef, useState } from 'react';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { LeaderboardsHomeBlockSkeleton } from '~/components/HomeBlocks/LeaderboardHomeBlockSkeleton';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import { LeaderHomeBlockCreatorItem } from '~/components/HomeBlocks/components/LeaderboardHomeBlockCreatorItem';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { trpc } from '~/utils/trpc';

type Props = { homeBlockId: number };

const useStyles = createStyles<
  string,
  { itemCount: number; columnWidth?: number; columnGap?: number }
>((theme, { itemCount, columnGap, columnWidth }) => ({
  root: {
    paddingTop: '32px',
    paddingBottom: '32px',
  },
  carousel: {
    [theme.fn.smallerThan('sm')]: {
      marginRight: -theme.spacing.md,
      marginLeft: -theme.spacing.md,
    },
  },
  nextButton: {
    backgroundColor: theme.colors.gray[0],
    color: theme.colors.dark[9],
    opacity: 0.65,
    transition: 'opacity 300ms ease',

    '&:hover': {
      opacity: 1,
      backgroundColor: theme.colors.gray[0],
    },

    [theme.fn.smallerThan('sm')]: {
      display: 'none',
    },
  },

  hidden: {
    display: 'none !important',
  },

  grid: {
    display: 'grid',
    gridAutoFlow: 'column',
    columnGap: columnGap,
    gridTemplateColumns: `repeat(${itemCount}, ${columnWidth}px)`,
    gridTemplateRows: 'auto',
    gridAutoRows: 0,
    overflowX: 'visible',
    paddingBottom: theme.spacing.md,

    [theme.fn.smallerThan('sm')]: {
      gridTemplateColumns: `repeat(${itemCount}, 280px)`,
      marginRight: -theme.spacing.md,
      marginLeft: -theme.spacing.md,
      paddingLeft: theme.spacing.md,
    },
  },
}));

export const LeaderboardsHomeBlock = ({ ...props }: Props) => {
  const { classes } = useStyles({ itemCount: 0 });

  return (
    <HomeBlockWrapper className={classes.root}>
      <LeaderboardsHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

export const LeaderboardsHomeBlockContent = ({ homeBlockId }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery({ id: homeBlockId });
  const { columnWidth, columnGap, columnCount, combinedWidth } = useMasonryContainerContext();
  const { classes, cx } = useStyles({
    itemCount: homeBlock?.leaderboards?.length ?? 0,
    columnGap,
    columnWidth,
  });
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, onScrollPositionChange] = useState({ x: 0, y: 0 });

  if (isLoading) {
    return <LeaderboardsHomeBlockSkeleton />;
  }

  if (!homeBlock || !homeBlock.leaderboards || homeBlock.leaderboards.length === 0) {
    return null;
  }

  const { leaderboards } = homeBlock;
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;

  const atStart = scrollPosition.x === 0;
  const atEnd = scrollPosition.x >= (columnCount - 1) * (columnWidth + columnGap);
  const scrollLeft = () => {
    const scrollValue = columnWidth + columnGap;
    const validPositions = Array.from(
      { length: columnCount },
      (_, idx) => scrollValue * idx
    ).reverse();
    const nextPosition = validPositions.find((pos) => pos < scrollPosition.x) ?? 0;
    viewportRef.current?.scrollTo({
      left: nextPosition,
      behavior: 'smooth',
    });
  };
  const scrollRight = () => {
    const scrollValue = columnWidth + columnGap;
    const validPositions = Array.from({ length: columnCount }, (_, idx) => scrollValue * idx);
    const nextPosition =
      validPositions.find((pos) => pos > scrollPosition.x) ??
      (columnCount - 1) * (columnWidth + columnGap);

    viewportRef.current?.scrollTo({
      left: nextPosition,
      behavior: 'smooth',
    });
  };

  return (
    <Stack spacing="xl">
      <div>
        <HomeBlockHeaderMeta metadata={metadata} />
      </div>

      <ScrollArea
        w={combinedWidth}
        viewportRef={viewportRef}
        onScrollPositionChange={onScrollPositionChange}
      >
        <div className={classes.grid}>
          {leaderboards.map((leaderboard) => {
            const displayedResults = leaderboard.results.slice(0, 4);

            return (
              <Card key={leaderboard.id} radius="md" w="100%" h="100%">
                <Group position="apart" align="center">
                  <Text size="lg">{leaderboard.title}</Text>
                  <Link href={`/leaderboard/${leaderboard.id}`} passHref>
                    <Button
                      rightIcon={<IconArrowRight size={16} />}
                      variant="subtle"
                      size="xs"
                      compact
                    >
                      More
                    </Button>
                  </Link>
                </Group>
                <Stack mt="md">
                  {displayedResults.length === 0 && (
                    <Text color="dimmed">No results have been published for this leaderboard</Text>
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
        <ActionIcon
          className={cx(classes.nextButton, { [classes.hidden]: atStart })}
          radius="xl"
          size="md"
          color="gray"
          p={4}
          sx={{ position: 'absolute', top: '50%', left: 10 }}
          onClick={scrollLeft}
        >
          <IconChevronLeft />
        </ActionIcon>
        <ActionIcon
          className={cx(classes.nextButton, { [classes.hidden]: atEnd })}
          radius="xl"
          size="md"
          color="gray"
          p={4}
          sx={{ position: 'absolute', top: '50%', right: 10 }}
          onClick={scrollRight}
        >
          <IconChevronRight />
        </ActionIcon>
      </ScrollArea>
    </Stack>
  );
};
