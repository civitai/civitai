import { AspectRatio, Skeleton } from '@mantine/core';
import clsx from 'clsx';
import { useMemo } from 'react';
import { ImageCard } from '~/components/Cards/ImageCard';
import { FlagRacePanel } from '~/components/HatTurf/FlagRace/FlagRacePanel';
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
 * The home row's Flag Race on the event page, signed in or not: while a flag day runs and the viewer
 * may see one of its flags. Under it, each team's race so far.
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
  const { images, isLoading } = useQueryImages(
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
  // In the day's flag order, not the feed's.
  const flags = useMemo(() => {
    const byId = new Map(images.map((image) => [image.id, image]));
    return ids.map((id) => byId.get(id)).filter((image) => !!image);
  }, [ids, images]);

  // Like the home row: nothing to show when the viewer may see none of the day's flags.
  if (!row || !ids.length || (!isLoading && !flags.length)) return null;
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
                  {flags.map((image) => (
                    <ImageCard key={image.id} data={image} />
                  ))}
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
