import { Box, Group, Stack, Text, useMantineTheme } from '@mantine/core';
import { IconCrown, IconTrophy } from '@tabler/icons-react';
import { NextLink as Link } from '~/components/NextLink/NextLink';

import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { LeaderboardGetModel } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { RankBadge } from '~/components/Leaderboard/RankBadge';
import { LeaderboardWithResults } from '~/server/services/leaderboard.service';
import { ContainerGrid } from '~/components/ContainerGrid/ContainerGrid';

export const LeaderHomeBlockCreatorItem = ({
  data: { position, user, score },
  leaderboard,
}: {
  leaderboard: LeaderboardWithResults;
  data: LeaderboardGetModel;
}) => {
  const theme = useMantineTheme();
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
    <div style={{ minHeight: 42 }}>
      <Link legacyBehavior href={link} passHref>
        <Box style={{ cursor: 'pointer' }}>
          <ContainerGrid align="center">
            <ContainerGrid.Col span={8}>
              <Group gap="xs" wrap="nowrap">
                <UserAvatar
                  avatarProps={{
                    radius: 'xl',
                  }}
                  user={user}
                  textSize="lg"
                  size="md"
                />
                <Stack gap={4} style={{ overflow: 'hidden' }}>
                  <Text
                    style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {user.username}
                  </Text>
                  <Group gap={4}>
                    <IconTrophy size={12} />
                    <Text size="xs">{abbreviateNumber(score)}</Text>
                  </Group>
                </Stack>
              </Group>
            </ContainerGrid.Col>
            <ContainerGrid.Col span={3}>
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
            </ContainerGrid.Col>
          </ContainerGrid>
        </Box>
      </Link>
    </div>
  );
};
