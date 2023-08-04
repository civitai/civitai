import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { Box, Button, Card, createStyles, Divider, Group, Stack, Text } from '@mantine/core';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import Link from 'next/link';
import { Carousel } from '@mantine/carousel';
import { LeaderHomeBlockCreatorItem } from '~/components/HomeBlocks/components/LeaderboardHomeBlockCreatorItem';
import { Fragment } from 'react';
import { IconArrowRight } from '@tabler/icons-react';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';
import { LeaderboardsHomeBlockSkeleton } from '~/components/HomeBlocks/LeaderboardHomeBlockSkeleton';
import { trpc } from '~/utils/trpc';

type Props = { homeBlockId: number };

const useStyles = createStyles((theme) => ({
  root: {
    paddingTop: '32px',
    paddingBottom: '32px',
    background:
      theme.colorScheme === 'dark'
        ? theme.colors.dark[8]
        : theme.fn.darken(theme.colors.gray[0], 0.01),
    paddingLeft: 0,
    paddingRight: 0,
  },
  metadata: {
    padding: theme.spacing.md,
  },
  carousel: {
    padding: theme.spacing.md,
    [theme.fn.smallerThan('md')]: {
      padding: 0,
    },
  },
}));

export const LeaderboardsHomeBlock = ({ homeBlockId }: Props) => {
  const { classes } = useStyles();
  const { data: homeBlock, isLoading } = trpc.homeBlock.getHomeBlock.useQuery({ id: homeBlockId });

  if (isLoading) {
    return <LeaderboardsHomeBlockSkeleton />;
  }

  if (!homeBlock || !homeBlock.leaderboards || homeBlock.leaderboards.length === 0) {
    return null;
  }

  const { leaderboards } = homeBlock;
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;

  return (
    <HomeBlockWrapper className={classes.root}>
      <Box className={classes.metadata}>
        <HomeBlockHeaderMeta metadata={metadata} />
      </Box>
      <Carousel
        loop
        slideSize="25%"
        slideGap="md"
        height="100%"
        align="start"
        breakpoints={[
          { maxWidth: 'md', slideSize: '50%', slideGap: 'md' },
          { maxWidth: 'sm', slideSize: '80%', slideGap: 'sm' },
        ]}
        className={classes.carousel}
        includeGapInSize={true}
        styles={{
          control: {
            '&[data-inactive]': {
              opacity: 0,
              cursor: 'default',
            },
          },
        }}
      >
        {leaderboards.map((leaderboard) => {
          const displayedResults = leaderboard.results.slice(0, 4);

          return (
            <Carousel.Slide key={leaderboard.id}>
              <Card radius="md" sx={{ minHeight: '100%' }}>
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
            </Carousel.Slide>
          );
        })}
      </Carousel>
    </HomeBlockWrapper>
  );
};
