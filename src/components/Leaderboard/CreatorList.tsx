import { Stack } from '@mantine/core';

import { CreatorCard } from '~/components/Leaderboard/CreatorCard';
import type { LeaderboardGetModel } from '~/types/router';

export function CreatorList({ data }: { data: LeaderboardGetModel[] }) {
  return (
    <Stack>
      {data.map((item, index) => (
        <CreatorCard key={item.position} index={index} data={item} />
      ))}
    </Stack>
  );
}
