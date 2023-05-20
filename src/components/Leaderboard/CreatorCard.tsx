import { Anchor, createStyles, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconCrown } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { InView } from 'react-intersection-observer';
import { LeaderboardMetrics } from '~/components/Leaderboard/LeaderboardMetrics';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { LeaderboardGetModel } from '~/types/router';

const linkQuery: Record<string, string> = {
  overall: '/models',
  overall_nsfw: '/models',
  writers: '/articles',
  'images-overall': '/images',
  'images-nsfw': '/images',
  'images-new': '/images',
  'images-funny': '/images',
  'images-rater': '/posts',
  'base model': '/models?tag=base+model',
  style: '/models?tag=style',
  clothing: '/models?tag=clothing',
  character: '/models?tag=character',
  celebrity: '/models?tag=celebrity',
  buildings: '/models?tag=buildings',
  backgrounds: '/models?tag=backgrounds',
  car: '/models?tag=car',
};

export function CreatorCard({
  data: { position, user, metrics, score },
  index,
}: {
  data: LeaderboardGetModel;
  index: number;
}) {
  const { classes, theme, cx } = useStyles();
  const router = useRouter();

  const { position: queryPosition, id: leaderboardId } = router.query;

  const isTop3 = position <= 3;
  const iconColor = [
    theme.colors.yellow[5], // Gold
    theme.colors.gray[5], // Silver
    theme.colors.orange[5], // Bronze
  ][position - 1];

  let link = `/user/${user.username}`;
  if (leaderboardId && typeof leaderboardId === 'string') link += linkQuery[leaderboardId] ?? '';

  return (
    <InView rootMargin="100%">
      {({ inView, ref }) => (
        <div ref={ref} className={classes.wrapper}>
          {inView && (
            <NextLink href={link}>
              <Paper
                className={cx(classes.creatorCard, Number(queryPosition) === position && 'active')}
                p="sm"
                radius="md"
                shadow="xs"
                withBorder
              >
                {/* {inView && ( */}
                <Grid align="center">
                  <Grid.Col span={2}>
                    <Group align="center" position="center" sx={{ position: 'relative' }}>
                      {isTop3 ? (
                        <IconCrown
                          size={64}
                          color={iconColor}
                          style={{ fill: iconColor, opacity: 0.4 }}
                        />
                      ) : null}
                      <Text
                        size="lg"
                        weight="bold"
                        sx={
                          isTop3
                            ? {
                                position: 'absolute',
                                top: '55%', // Slight vertical offset to center in icon
                                left: '50%',
                                transform: 'translate(-50%, -50%)',
                                lineHeight: 1,
                              }
                            : undefined
                        }
                      >
                        {position}
                      </Text>
                    </Group>
                  </Grid.Col>
                  <Grid.Col span={10}>
                    <Stack spacing={8}>
                      <UserAvatar user={user} textSize="lg" size="md" withUsername />
                      <LeaderboardMetrics score={score} metrics={metrics} />
                    </Stack>
                  </Grid.Col>
                </Grid>
              </Paper>
            </NextLink>
          )}
        </div>
      )}
    </InView>
  );
}

const useStyles = createStyles((theme) => ({
  wrapper: {
    minHeight: 98,
  },
  creatorCard: {
    // height: 98,
    '&.active': {
      borderColor: theme.colors.blue[8],
      boxShadow: `0 0 10px ${theme.colors.blue[8]}`,
    },
    '&:hover': {
      backgroundColor:
        theme.colorScheme === 'dark' ? 'rgba(255,255,255, 0.03)' : 'rgba(0,0,0, 0.01)',
    },
  },
}));
