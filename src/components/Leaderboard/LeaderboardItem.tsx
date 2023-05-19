import { Anchor, createStyles, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCrown } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { LeaderboardMetrics } from '~/components/Leaderboard/LeaderboardMetrics';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { LeaderboardGetModel } from '~/types/router';

export function LeaderboardItem({ position, user, metrics }: LeaderboardGetModel) {
  const { classes, theme, cx } = useStyles();
  const router = useRouter();

  const { position: queryPosition } = router.query;

  useEffect(() => {
    if (queryPosition && typeof queryPosition === 'string') {
      const card = document.getElementById(queryPosition);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [queryPosition]);

  const isTop3 = position <= 3;
  const iconColor = [
    theme.colors.yellow[5], // Gold
    theme.colors.gray[5], // Silver
    theme.colors.orange[5], // Bronze
  ][position - 1];
  return (
    <Link key={user.id} href={`/user/${user.username}`} passHref>
      <Anchor variant="text" id={`${position}`}>
        <Paper
          className={cx(classes.creatorCard, Number(queryPosition) === position && 'active')}
          p="sm"
          radius="md"
          shadow="xs"
          withBorder
        >
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
                <LeaderboardMetrics metrics={metrics} />
              </Stack>
            </Grid.Col>
          </Grid>
        </Paper>
      </Anchor>
    </Link>
  );
}

const useStyles = createStyles((theme) => ({
  creatorCard: {
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
