import { useMantineTheme } from '@mantine/core';
import { List } from 'masonic';
import { useRouter } from 'next/router';
import { z } from 'zod';

import { CreatorCard } from '~/components/Leaderboard/CreatorCard';
import { numericString } from '~/utils/zod-helpers';
import { LeaderboardGetModel } from '~/types/router';

const schema = z.object({
  position: numericString().optional(),
});

export function CreatorList({ data }: { data: LeaderboardGetModel[] }) {
  const theme = useMantineTheme();
  const router = useRouter();
  const result = schema.safeParse(router.query);
  let position: number | undefined = undefined;
  if (result.success) position = result.data.position;

  return (
    <List
      items={data}
      render={CreatorCard}
      scrollToIndex={
        position && position <= data.length
          ? { index: data.findIndex((x) => x.position === Number(position)), align: 'center' }
          : undefined
      }
      rowGutter={theme.spacing.md}
      overscanBy={3}
      itemHeightEstimate={98}
    />
  );
}
