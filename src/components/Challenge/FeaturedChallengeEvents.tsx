import { useMemo } from 'react';
import { EventBannerCard } from '~/components/Challenge/EventBannerCard';
import { SectionBand } from '~/components/Challenge/SectionBand';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { trpc } from '~/utils/trpc';

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
        .filter((e) => e.challenges.length > 0) ?? [],
    [events, filteredIds]
  );

  // No skeleton band: most page loads have no active event, so a placeholder band would appear
  // and then vanish. Better to have the banner pop in once we know there's one to show.
  if (isLoading || loadingPreferences) return null;

  if (visibleEvents.length === 0) return null;

  if (visibleEvents.length === 1)
    return (
      <SectionBand>
        <EventBannerCard event={visibleEvents[0]} />
      </SectionBand>
    );

  return (
    <SectionBand>
      <Embla loop withIndicators>
        <Embla.Viewport>
          <Embla.Container className="-ml-4 flex">
            {visibleEvents.map((event, index) => (
              <Embla.Slide key={event.id} index={index} className="flex-[0_0_100%] pl-4">
                <EventBannerCard event={event} />
              </Embla.Slide>
            ))}
          </Embla.Container>
        </Embla.Viewport>
      </Embla>
    </SectionBand>
  );
}
