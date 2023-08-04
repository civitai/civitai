import { Box, createStyles, Grid, Group, Stack, Text } from '@mantine/core';
import { IconCrown, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { LeaderboardGetModel } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { LeaderboardWithResults } from '~/server/services/leaderboard.service';

const useStyles = createStyles(() => ({
  wrapper: {
    minHeight: 42,
  },
}));

export const LeaderHomeBlockCreatorItem = ({
  data: { position, user, score },
  leaderboard,
}: {
  leaderboard: LeaderboardWithResults;
  data: LeaderboardGetModel;
}) => {
  const { classes, theme } = useStyles();

  const link = `/user/${user.username}`;
  const cosmetic = leaderboard.cosmetics.find(
    (cosmetic) => cosmetic.leaderboardPosition && cosmetic.leaderboardPosition >= position
  );
  const cosmeticData = cosmetic?.data as { url?: string };
  const isTop3 = position <= 3;
  const iconColor = [
    theme.colors.yellow[5], // Gold
    theme.colors.gray[5], // Silver
    theme.colors.orange[5], // Bronze
  ][position - 1];

  return (
    <div className={classes.wrapper}>
      <Link href={link} passHref>
        <Box sx={{ cursor: 'pointer' }}>
          <Grid align="center">
            <Grid.Col span={1}>
              <Text>{position}</Text>
            </Grid.Col>
            <Grid.Col span={8}>
              <Group spacing="xs" noWrap>
                <UserAvatar
                  avatarProps={{
                    radius: 'md',
                  }}
                  user={user}
                  textSize="lg"
                  size="md"
                />
                <Stack spacing={4} style={{ overflow: 'hidden' }}>
                  <Text
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {user.username}
                  </Text>
                  <Group spacing={4}>
                    <IconTrophy size={12} />
                    <Text size="xs">{abbreviateNumber(score)}</Text>
                  </Group>
                </Stack>
              </Group>
            </Grid.Col>
            <Grid.Col span={3}>
              <Stack align="flex-end">
                {cosmetic && cosmeticData ? (
                  <RankBadge
                    size="xs"
                    rank={{
                      leaderboardRank: position,
                      leaderboardId: leaderboard.id,
                      leaderboardTitle: leaderboard.title,
                      leaderboardCosmetic: cosmeticData.url,
                    }}
                  />
                ) : isTop3 ? (
                  <IconCrown size={24} color={iconColor} style={{ fill: iconColor }} />
                ) : null}
              </Stack>
            </Grid.Col>
          </Grid>
        </Box>
      </Link>
    </div>
  );
};
