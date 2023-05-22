import { useMantineTheme } from '@mantine/core';
import { List } from 'masonic';

import { useRouter } from 'next/router';
import { LeaderboardGetModel } from '~/types/router';
import { CreatorCard } from '~/components/Leaderboard/CreatorCard';

export function CreatorList({ data }: { data: LeaderboardGetModel[] }) {
  const theme = useMantineTheme();
  const router = useRouter();
  const { position } = router.query;

  return (
    <List
      items={data}
      render={CreatorCard}
      scrollToIndex={
        position
          ? { index: data.findIndex((x) => x.position === Number(position)), align: 'center' }
          : undefined
      }
      rowGutter={theme.spacing.md}
      overscanBy={3}
      itemHeightEstimate={98}
    />
  );
}
