import { BadgeProps, MantineSize, Text } from '@mantine/core';
import { IconCrown } from '@tabler/icons';
import { IconBadge } from '~/components/IconBadge/IconBadge';

export const RankBadge = ({ rank, size, textSize = 'sm', iconSize = 18, ...props }: Props) => {
  if (!rank || !rank.leaderboardRank || rank.leaderboardRank > 100) return null;

  return (
    <IconBadge
      size={size}
      tooltip={`${rank.leaderboardTitle} Rank`}
      color="yellow"
      href={`/leaderboard/${rank.leaderboardId}?position=${rank.leaderboardRank}`}
      icon={<IconCrown size={iconSize} />}
      {...props}
    >
      <Text size={textSize}>{rank.leaderboardRank}</Text>
    </IconBadge>
  );
};

type Props = {
  rank: {
    leaderboardRank: number | null;
    leaderboardId: string | null;
    leaderboardTitle: string | null;
  } | null;
  textSize?: MantineSize;
  iconSize?: number;
} & Omit<BadgeProps, 'leftSection'>;
