import { Carousel } from '@mantine/carousel';
import {
  ActionIcon,
  Box,
  Button,
  Card,
  Divider,
  Group,
  ScrollArea,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { getHotkeyHandler } from '@mantine/hooks';
import { IconArrowRight, IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import Link from 'next/link';
import { Fragment, useRef, useState } from 'react';
import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { LeaderboardsHomeBlockSkeleton } from '~/components/HomeBlocks/LeaderboardHomeBlockSkeleton';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import { LeaderHomeBlockCreatorItem } from '~/components/HomeBlocks/components/LeaderboardHomeBlockCreatorItem';
import { useMasonryContainerContext } from '~/components/MasonryColumns/MasonryContainer';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { trpc } from '~/utils/trpc';

type Props = { homeBlockId: number };

const useStyles = createStyles<string, { count: number }>((theme, { count }) => ({
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
  },

  hidden: {
    display: 'none !important',
  },

  grid: {
    display: 'grid',
    gridAutoFlow: 'column',
    columnGap: theme.spacing.md,
    gridTemplateColumns: `1fr`,
    gridTemplateRows: 'auto',
    gridAutoRows: 0,
    scrollSnapType: 'x mandatory',
    overflowX: 'auto',
    marginRight: -theme.spacing.md,
    marginLeft: -theme.spacing.md,

    [theme.fn.smallerThan('md')]: {
      // gridAutoFlow: 'column',
      // gridTemplateColumns: `repeat(${count / 2}, minmax(280px, 1fr) )`,
      // gridTemplateRows: `repeat(2, auto)`,
      // scrollSnapType: 'x mandatory',
      overflowX: 'auto',
    },

    [theme.fn.smallerThan('sm')]: {
      '& > *': {
        scrollSnapAlign: 'center',
      },
    },
  },
}));

export const LeaderboardsHomeBlock = ({ ...props }: Props) => {
  const { classes } = useStyles({ count: 0 });

  return (
    <HomeBlockWrapper className={classes.root}>
      <LeaderboardsHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
};

export const LeaderboardsHomeBlockContent = ({ homeBlockId }: Props) => {
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery({ id: homeBlockId });
  const { classes, cx } = useStyles({ count: homeBlock?.leaderboards?.length ?? 0 });
  const { columnWidth, columnGap } = useMasonryContainerContext();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollPosition, setScrollPosition] = useState({ x: 0, y: 0 });

  console.log({ columnWidth });

  if (isLoading) {
    return <LeaderboardsHomeBlockSkeleton />;
  }

  if (!homeBlock || !homeBlock.leaderboards || homeBlock.leaderboards.length === 0) {
    return null;
  }

  const { leaderboards } = homeBlock;
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;

  const atStart = scrollPosition.x === 0;
  const atEnd =
    viewportRef.current &&
    scrollPosition.x >= viewportRef.current.scrollWidth - viewportRef.current.offsetWidth - 1;

  const scrollLeft = () => viewportRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  const scrollRight = () => viewportRef.current?.scrollBy({ left: 200, behavior: 'smooth' });

  return (
    <Stack spacing="xl">
      <div>
        <HomeBlockHeaderMeta metadata={metadata} />
      </div>

      <div className={classes.grid}>
        <Group spacing="md" noWrap>
          {leaderboards.map((leaderboard) => {
            const displayedResults = leaderboard.results.slice(0, 4);

            return (
              <Card key={leaderboard.id} radius="md" w={columnWidth}>
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
        </Group>

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
      </div>
    </Stack>
  );
};
