import { Stack } from '@mantine/core';
import { useEffect } from 'react';

import { CreatorCard } from '~/components/Leaderboard/CreatorCard';
import type { LeaderboardGetModel } from '~/types/router';

export function CreatorList({
  data,
  highlightedPosition,
  scrollRequest,
}: {
  data: LeaderboardGetModel[];
  highlightedPosition?: number | null;
  /** Bump to scroll to `highlightedPosition` again, e.g. the same badge clicked twice. */
  scrollRequest?: number;
}) {
  // Rows are keyed by position and stay mounted across boards, so the scroll runs here on each
  // new board or request rather than once per row mount.
  useEffect(() => {
    if (!highlightedPosition) return;
    document.getElementById(String(highlightedPosition))?.scrollIntoView({ block: 'center' });
  }, [highlightedPosition, data, scrollRequest]);

  return (
    <Stack>
      {data.map((item, index) => (
        <CreatorCard
          key={item.position}
          index={index}
          data={item}
          highlighted={item.position === highlightedPosition}
        />
      ))}
    </Stack>
  );
}
