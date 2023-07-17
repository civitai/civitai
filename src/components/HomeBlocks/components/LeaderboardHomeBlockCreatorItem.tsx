import { Box, createStyles, Grid, Group, Stack, Text } from '@mantine/core';
import { IconCrown, IconTrophy } from '@tabler/icons-react';
import Link from 'next/link';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { LeaderboardGetModel } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
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

  const isTop3 = position <= 3;
  const iconColor = [
    theme.colors.yellow[5], // Gold
    theme.colors.gray[5], // Silver
    theme.colors.orange[5], // Bronze
  ][position - 1];

  const link = `/user/${user.username}`;
  const leaderboardCosmeticItem = user.cosmetics.find((cosmeticItem) => {
    const cosmetic = cosmeticItem?.cosmetic;
    if (!cosmetic) {
      return false;
    }

    return cosmetic.leaderboardId === leaderboard.id;
  });

  const leaderboardCosmetic = leaderboardCosmeticItem?.cosmetic;
  const leaderboardCosmeticData = leaderboardCosmetic?.data
    ? (leaderboardCosmetic?.data as unknown as { url: string })
    : null;

  return (
    <div className={classes.wrapper}>
      <Link href={link} passHref>
        <Box sx={{ cursor: 'pointer' }}>
          <Grid align="center">
            <Grid.Col span={1}>
              <Text>{position}</Text>
            </Grid.Col>
            <Grid.Col span={8}>
              <Group spacing="xs">
                <UserAvatar
                  avatarProps={{
                    radius: 'md',
                  }}
                  user={user}
                  textSize="lg"
                  size="md"
                />
                <Stack spacing={4}>
                  <Text>{user.username}</Text>
                  <Group spacing={4}>
                    <IconTrophy size={12} />
                    <Text size="xs">{numberWithCommas(score) || 0}</Text>
                  </Group>
                </Stack>
              </Group>
            </Grid.Col>
            <Grid.Col span={3}>
              <Stack align="flex-end">
                {/*{false && <EdgeImage src={user} width={24} />}*/}
                {leaderboardCosmetic && (
                  <RankBadge
                    size="xs"
                    rank={{
                      leaderboardRank: leaderboardCosmetic.leaderboardPosition,
                      leaderboardId: leaderboard.id,
                      leaderboardTitle: leaderboard.title,
                      leaderboardCosmetic: leaderboardCosmeticData?.url,
                    }}
                  />
                )}
                {isTop3 && !leaderboardCosmetic && (
                  <IconCrown size={24} color={iconColor} style={{ fill: iconColor }} />
                )}
              </Stack>
            </Grid.Col>
          </Grid>
        </Box>
      </Link>
    </div>
  );
};
