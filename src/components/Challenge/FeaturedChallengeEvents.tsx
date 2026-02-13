import { useMemo } from 'react';
import clsx from 'clsx';
import { Stack, Title } from '@mantine/core';
import { ChallengeCard } from '~/components/Cards/ChallengeCard';
import { TwScrollX } from '~/components/TwScrollX/TwScrollX';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
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
  const {
    data: events,
    isLoading,
    isRefetching,
  } = trpc.challenge.getActiveEvents.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });

  const allChallenges = useMemo(() => events?.flatMap((e) => e.challenges) ?? [], [events]);

  const { items: filteredChallenges, loadingPreferences } = useApplyHiddenPreferences({
    type: 'challenges',
    data: allChallenges,
    isRefetching,
  });

  const filteredIds = useMemo(
    () => new Set(filteredChallenges.map((c) => c.id)),
    [filteredChallenges]
  );

  const visibleEvents = useMemo(
    () =>
      events
        ?.map((event) => ({
          ...event,
          challenges: event.challenges.filter((c) => filteredIds.has(c.id)),
        }))
        .filter((e) => e.challenges.length > 0),
    [events, filteredIds]
  );

  if (isLoading || loadingPreferences || !visibleEvents || visibleEvents.length === 0) return null;

  return (
    <Stack gap="md">
      {visibleEvents.map((event) => (
        <Stack key={event.id} gap="xs">
          <Title order={3} className={clsx(event.titleColor && eventTitleColors[event.titleColor])}>
            {event.title}
          </Title>
          <TwScrollX className="flex gap-4">
            {event.challenges.map((challenge) => (
              <div key={challenge.id} className="w-[320px] shrink-0">
                <ChallengeCard data={challenge} />
              </div>
            ))}
          </TwScrollX>
        </Stack>
      ))}
    </Stack>
  );
}
