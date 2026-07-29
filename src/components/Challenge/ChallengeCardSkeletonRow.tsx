import { Skeleton } from '@mantine/core';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';

// Placeholder row shown while a challenge section fetches, matching the 320px square
// ChallengeCard/MyChallengeCard footprint so the layout doesn't shift when cards land.
export function ChallengeCardSkeletonRow({ count = 4 }: { count?: number }) {
  return (
    <TwScrollX className="flex gap-4">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={320} width={320} radius="md" className="shrink-0" />
      ))}
    </TwScrollX>
  );
}
