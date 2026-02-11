import clsx from 'clsx';
import { Stack, Title } from '@mantine/core';
import { ChallengeCard } from '~/components/Cards/ChallengeCard';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { trpc } from '~/utils/trpc';

const eventTitleColors: Record<string, string> = {
  blue: 'text-blue-400',
  purple: 'text-purple-400',
  red: 'text-red-400',
  orange: 'text-orange-400',
  yellow: 'text-yellow-400',
  green: 'text-green-400',
  pink: 'text-pink-400',
};

export function FeaturedChallengeEvents() {
  const { data: events, isLoading } = trpc.challenge.getActiveEvents.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });

  const visibleEvents = events?.filter((e) => e.challenges.length > 0);
  if (isLoading || !visibleEvents || visibleEvents.length === 0) return null;

  return (
    <Stack gap="md">
      {visibleEvents.map((event) => (
        <Stack key={event.id} gap="xs">
          <Title order={3} className={clsx(event.titleColor && eventTitleColors[event.titleColor])}>
            {event.title}
          </Title>
          <TwScrollX className="flex gap-4">
            {event.challenges.map((challenge) => (
              <div key={challenge.id} className="w-[250px] shrink-0">
                <ChallengeCard data={challenge} />
              </div>
            ))}
          </TwScrollX>
        </Stack>
      ))}
    </Stack>
  );
}
