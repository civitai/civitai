import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';
import { Button, Card, createStyles, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import Link from 'next/link';
import { Carousel } from '@mantine/carousel';
import { LeaderHomeBlockCreatorItem } from '~/components/HomeBlocks/components/LeaderboardHomeBlockCreatorItem';
import { Fragment } from 'react';
import { IconArrowRight, IconTrash } from '@tabler/icons-react';

type Props = { homeBlock: HomeBlockGetAll[number] };

const useStyles = createStyles((theme) => ({
  root: {
    paddingTop: '32px',
    paddingBottom: '32px',
    background:
      theme.colorScheme === 'dark'
        ? theme.colors.dark[8]
        : theme.fn.darken(theme.colors.gray[0], 0.01),
  },
}));
export const LeaderboardsHomeBlock = ({ homeBlock }: Props) => {
  const { classes } = useStyles();

  if (!homeBlock.leaderboards || homeBlock.leaderboards.length === 0) {
    return null;
  }

  const { leaderboards } = homeBlock;
  const metadata = homeBlock.metadata as HomeBlockMetaSchema;

  return (
    <HomeBlockWrapper className={classes.root}>
      {metadata?.title && (
        <Group position="apart" align="center" pb="md">
          <Title>{metadata?.title}</Title>
          {metadata.link && metadata.linkText && (
            <Link href={metadata.link} passHref>
              <Button
                rightIcon={<IconArrowRight size={16} />}
                variant="subtle"
                size="md"
                compact
                style={{ padding: 0 }}
              >
                {metadata.linkText}
              </Button>
            </Link>
          )}
        </Group>
      )}
      {metadata?.description && <Text mb="md">{metadata?.description}</Text>}
      <Carousel
        loop={false}
        slideSize="25%"
        slideGap="md"
        height="100%"
        align="start"
        sx={{ flex: 1 }}
        breakpoints={[
          { maxWidth: 'md', slideSize: '50%', slideGap: 'md' },
          { maxWidth: 'sm', slideSize: '100%', slideGap: 'sm' },
        ]}
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
              <Card sx={{ minHeight: '100%' }}>
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
                    <Text sx={{ opacity: 0.5 }}>
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
            </Carousel.Slide>
          );
        })}
      </Carousel>
    </HomeBlockWrapper>
  );
};
