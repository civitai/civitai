import { BadgeProps, Group, MantineSize, Text } from '@mantine/core';
import { IconCrown } from '@tabler/icons-react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { IconBadge } from '~/components/IconBadge/IconBadge';

export const RankBadge = ({ rank, size, textSize = 'sm', iconSize = 18, ...props }: Props) => {
  if (!rank || !rank.leaderboardRank || rank.leaderboardRank > 100) return null;

  const hasLeaderboardCosmetic = !!rank.leaderboardCosmetic;

  return (
    <Group spacing={0} noWrap>
      {rank.leaderboardCosmetic ? <EdgeImage src={rank.leaderboardCosmetic} width={32} /> : null}
      <IconBadge
        size={size}
        tooltip={`${rank.leaderboardTitle} Rank`}
        color="yellow"
        // variant="outline"
        href={`/leaderboard/${rank.leaderboardId}?position=${rank.leaderboardRank}`}
        icon={!hasLeaderboardCosmetic ? <IconCrown size={iconSize} /> : undefined}
        sx={
          hasLeaderboardCosmetic
            ? { padding: '2px 8px', marginLeft: '-2px', height: 'auto' }
            : undefined
        }
        {...props}
      >
        <Text size={textSize} inline>
          #{rank.leaderboardRank}
        </Text>
      </IconBadge>
    </Group>
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
