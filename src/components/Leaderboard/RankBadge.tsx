import { BadgeProps, MantineSize, Text } from '@mantine/core';
import { IconCrown } from '@tabler/icons';
import { IconBadge } from '~/components/IconBadge/IconBadge';

export const RankBadge = ({ rank, size, textSize = 'sm', iconSize = 18, ...props }: Props) => {
  if (!rank || rank > 100) return null;

  return (
    <IconBadge
      size={size}
      tooltip="User Rank"
      color="yellow"
      href={`/leaderboard?position=${rank}`}
      icon={<IconCrown size={iconSize} />}
      {...props}
    >
      <Text size={textSize}>{rank}</Text>
    </IconBadge>
  );
};

type Props = {
  rank: number | undefined;
  textSize?: MantineSize;
  iconSize?: number;
} & Omit<BadgeProps, 'leftSection'>;
