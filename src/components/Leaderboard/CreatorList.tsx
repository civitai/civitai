import { Anchor, createStyles, Grid, Group, Paper, Stack, Text } from '@mantine/core';
import { IconCrown } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { UserStatBadges } from '~/components/UserStatBadges/UserStatBadges';
import { LeaderboardGetAll } from '~/types/router';

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

export function CreatorList({ items }: Props) {
  const { classes, theme, cx } = useStyles();
  const router = useRouter();

  const { position } = router.query;

  useEffect(() => {
    if (position && typeof position === 'string') {
      const card = document.getElementById(position);
      card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [position]);

  return (
    <Stack>
      {items.map((creator, index) => {
        const { stats } = creator;

        const rankPosition = index + 1;
        const isTop3 = rankPosition <= 3;
        const iconColor =
          index === 0
            ? theme.colors.yellow[5] // Gold
            : index === 1
            ? theme.colors.gray[5] // Silver
            : theme.colors.orange[5]; // Bronze

        return (
          <Link key={creator.id} href={`/user/${creator.username}`} passHref>
            <Anchor variant="text" id={`${rankPosition}`}>
              <Paper
                className={cx(classes.creatorCard, Number(position) === rankPosition && 'active')}
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
                        {index + 1}
                      </Text>
                    </Group>
                  </Grid.Col>
                  <Grid.Col span={10}>
                    <Stack spacing={8}>
                      <UserAvatar user={creator} textSize="lg" size="md" withUsername />
                      {stats && (
                        <UserStatBadges
                          rating={{
                            count: stats.ratingCountMonth,
                            value: stats.ratingMonth,
                          }}
                          favorite={stats.favoriteCountMonth}
                          downloads={stats.downloadCountMonth}
                          answers={stats.answerCountMonth}
                          size="lg"
                        />
                      )}
                    </Stack>
                  </Grid.Col>
                </Grid>
              </Paper>
            </Anchor>
          </Link>
        );
      })}
    </Stack>
  );
}

type Props = {
  items: LeaderboardGetAll;
};
