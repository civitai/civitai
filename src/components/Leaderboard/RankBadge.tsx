import { BadgeProps, Box, Group, MantineColor, MantineSize, Text, Tooltip } from '@mantine/core';
import { IconCrown } from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';

const rankColors: Record<number, MantineColor> = {
  1: 'blue',
  3: 'yellow',
  10: 'silver',
  100: 'orange',
};

export const RankBadge = ({ rank, size, textSize = 'sm', iconSize = 18, ...props }: Props) => {
  if (!rank || !rank.leaderboardRank || rank.leaderboardRank > 100) return null;

  let badgeColor: MantineColor = 'gray';
  for (const [rankLimit, rankColor] of Object.entries(rankColors)) {
    if (rank.leaderboardRank <= parseInt(rankLimit)) {
      badgeColor = rankColor;
      break;
    }
  }

  const hasLeaderboardCosmetic = !!rank.leaderboardCosmetic;

  return (
    <Tooltip label={`${rank.leaderboardTitle} Rank`} position="top" color="dark" withArrow>
      <Group spacing={0} noWrap sx={{ position: 'relative' }}>
        {rank.leaderboardCosmetic ? (
          <Box pos="relative" sx={{ zIndex: 2 }}>
            <EdgeImage src={rank.leaderboardCosmetic} width={32} />
          </Box>
        ) : null}
        <IconBadge
          size={size}
          color={badgeColor}
          href={`/leaderboard/${rank.leaderboardId}?position=${rank.leaderboardRank}`}
          icon={!hasLeaderboardCosmetic ? <IconCrown size={iconSize} /> : undefined}
          sx={
            hasLeaderboardCosmetic
              ? {
                  paddingLeft: 16,
                  marginLeft: -14,
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                }
              : undefined
          }
          {...props}
        >
          <Text size={textSize} inline>
            #{rank.leaderboardRank}
          </Text>
        </IconBadge>
      </Group>
    </Tooltip>
  );
};

type Props = {
  rank: {
    leaderboardRank: number | null;
    leaderboardId: string | null;
    leaderboardTitle: string | null;
    leaderboardCosmetic?: string | null;
  } | null;
  textSize?: MantineSize;
  iconSize?: number;
} & Omit<BadgeProps, 'leftSection'>;
