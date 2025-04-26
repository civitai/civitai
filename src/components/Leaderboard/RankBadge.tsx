import { BadgeProps, Box, Group, MantineColor, MantineSize, Text, Tooltip } from '@mantine/core';
import { IconCrown } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import styles from './RankBadge.module.scss';

const rankColors: Record<number, MantineColor> = {
  1: 'blue',
  3: 'yellow',
  10: 'gray',
  100: 'orange',
};

export const RankBadge = ({
  rank,
  size,
  textSize = 'sm',
  iconSize = 18,
  withTitle,
  ...props
}: Props) => {
  if (!rank || !rank.leaderboardRank || rank.leaderboardRank > 100) return null;

  let rankClass = styles.rank100;
  for (const [rankLimit] of Object.entries(rankColors)) {
    if (rank.leaderboardRank <= parseInt(rankLimit)) {
      rankClass = styles[`rank${rankLimit}`];
      break;
    }
  }

  const hasLeaderboardCosmetic = !!rank.leaderboardCosmetic;
  const badgeClasses = [
    styles.rankBadge,
    rankClass,
    withTitle ? styles.transparent : '',
    hasLeaderboardCosmetic ? styles.cosmeticBadge : '',
  ].join(' ');

  return (
    <Tooltip label={`${rank.leaderboardTitle} Rank`} position="top" color="dark" withArrow>
      <Group spacing={0} noWrap sx={{ position: 'relative' }}>
        {rank.leaderboardCosmetic ? (
          <Box className={styles.cosmeticImage}>
            <EdgeMedia
              src={rank.leaderboardCosmetic}
              alt={`${rank.leaderboardTitle} position #${rank.leaderboardRank}`}
              width={32}
            />
          </Box>
        ) : null}
        <IconBadge
          size={size}
          className={badgeClasses}
          href={`/leaderboard/${rank.leaderboardId}?position=${rank.leaderboardRank}`}
          icon={!hasLeaderboardCosmetic ? <IconCrown size={iconSize} /> : undefined}
          {...props}
        >
          <Text size={textSize} className={styles.rankNumber} inline>
            #{rank.leaderboardRank}
          </Text>
          {withTitle && (
            <Text size={textSize} className={styles.rankTitle} inline>
              {' '}
              {rank.leaderboardTitle}
            </Text>
          )}
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
  withTitle?: boolean;
} & Omit<BadgeProps, 'leftSection'>;

