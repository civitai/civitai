import { AspectRatio, Skeleton } from '@mantine/core';
import clsx from 'clsx';
import { useMemo } from 'react';
import { ImageCard } from '~/components/Cards/ImageCard';
import { FlagRacePanel } from '~/components/HatTurf/FlagRace/FlagRacePanel';
import { HiddenFlagCard } from '~/components/HatTurf/FlagRace/HiddenFlagCard';
import { useFlagReveal } from '~/components/HatTurf/FlagRace/useFlagReveal';
import { FlagRaceTotals } from '~/components/HatTurf/FlagRace/FlagRaceTotals';
import flagClasses from '~/components/HatTurf/FlagRace/FlagRacePanel.module.scss';
import { FlagRowProviders, useFlagRow } from '~/components/HatTurf/FlagRace/FlagRowProviders';
import partyClasses from '~/components/HomeBlocks/ScoredEventHomeBlock.module.scss';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { RemixFlyoutLayoutProvider } from '~/components/RemixGallery/remix-flyout-layout';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ImageSort } from '~/server/common/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

/**
 * The home row's Flag Race on the event page, signed in or not, while a flag day runs. Under it, each
 * team's race so far. The panel and totals come from the day's summary, so they show in full even
 * when the viewer may not see some or all of the flags; those show as hidden cards.
 */
export function FlagRaceEventSection({
  event,
  myTeam,
  teamHats,
}: {
  event: string;
  myTeam?: string;
  teamHats?: { team: string; url: string | null }[];
}) {
  const features = useFeatureFlags();
  const row = useFlagRow(features.flagRace ? event : undefined);
  const ids = useMemo(() => row?.summary.flags.map((f) => f.imageId) ?? [], [row]);
  const { images, flatData, isLoading } = useQueryImages(
    {
      ids,
      period: MetricTimeframe.AllTime,
      sort: ImageSort.Newest,
      limit: ids.length || 1,
      withMeta: false,
      include: ['cosmetics'],
    },
    { enabled: ids.length > 0 }
  );
  // Flags the server served but the viewer's hidden preferences took out (a block, a hidden user
  // or tag): hidden for them, unless only their own preferences hid one and they show it anyway.
  const hiddenServed = useMemo(() => {
    const kept = new Set(images.map((image) => image.id));
    return (flatData ?? []).filter((image) => !kept.has(image.id));
  }, [images, flatData]);
  const { reasons, revealed, reveal } = useFlagReveal(hiddenServed);
  // In the day's flag order, not the feed's. A flag the server did not serve (removed by a
  // moderator, deleted) has no slot at all.
  const { slots, flags } = useMemo(() => {
    const byId = new Map([...images, ...revealed].map((image) => [image.id, image]));
    const served = new Set((flatData ?? []).map((image) => image.id));
    const slots = ids.filter((id) => served.has(id)).map((id) => ({ id, image: byId.get(id) }));
    return { slots, flags: slots.flatMap((s) => (s.image ? [s.image] : [])) };
  }, [ids, images, revealed, flatData]);

  if (!row || !ids.length) return null;
  return (
    <div className={flagClasses.wrap} data-testid="flag-race-event-section">
      <section className={clsx(partyClasses.party, flagClasses.row)}>
        <FlagRacePanel event={event} summary={row.summary} />
        <div className={flagClasses.flags}>
          {isLoading ? (
            ids.map((id) => (
              <AspectRatio ratio={7 / 9} key={id}>
                <Skeleton width="100%" />
              </AspectRatio>
            ))
          ) : (
            <FlagRowProviders row={row}>
              <RemixFlyoutLayoutProvider layout="side">
                <ImagesProvider images={flags}>
                  {slots.map(({ id, image }) =>
                    image ? (
                      <ImageCard key={id} data={image} />
                    ) : (
                      <HiddenFlagCard
                        key={id}
                        imageId={id}
                        reason={reasons.get(id)}
                        onShow={() => reveal(id)}
                      />
                    )
                  )}
                </ImagesProvider>
              </RemixFlyoutLayoutProvider>
            </FlagRowProviders>
          )}
        </div>
        <FlagRaceTotals event={event} myTeam={myTeam} teamHats={teamHats} />
      </section>
    </div>
  );
}
