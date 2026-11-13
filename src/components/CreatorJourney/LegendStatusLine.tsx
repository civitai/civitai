import { Text } from '@mantine/core';
import { legendStatusLabel } from '~/components/CreatorJourney/legend-status';
import { trpc } from '~/utils/trpc';

export function LegendStatusLine({ userId }: { userId: number }) {
  const { data } = trpc.creatorJourney.getLegendStatus.useQuery({ userId });
  if (!data) return null;

  return (
    <Text size="sm" fw={600} c="yellow.5">
      {legendStatusLabel(data)}
    </Text>
  );
}
