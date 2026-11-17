import { useEffect, useMemo } from 'react';
import { HatTurfCardProvider, useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { TurfSummaryProvider } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfDetail } from '~/components/HatTurf/detail/useHatTurfDetail';
import { FlagRaceContext } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

type DetailImage = { id: number; type: string };

/** Hat Turf is for pictures and videos only. */
export const takesHats = (image: DetailImage | undefined) =>
  image?.type === 'image' || image?.type === 'video';

/**
 * Standings for every picture in the carousel, and the draft hat of the one on screen. Wraps the
 * whole detail page rather than keying on the image, so a swipe doesn't remount the page; the draft
 * is cleared when the picture changes instead (HatTurfDetailReset).
 */
export function HatTurfDetailProvider({
  images,
  children,
}: {
  images: DetailImage[];
  children: React.ReactNode;
}) {
  const gate = useHatTurfDetail();
  const imageIds = useMemo(() => images.filter(takesHats).map((image) => image.id), [images]);
  // Today's flags, so a flag shows its flag badge and takes stacked hats here as on the home row.
  const features = useFeatureFlags();
  const flagEvent = features.flagRace ? gate?.event : undefined;
  // The home row's query and options, so the two share one edge-cached, viewer-agnostic answer.
  const { data: flagSummary } = trpc.hatTurf.getFlags.useQuery(
    { event: flagEvent ?? '' },
    {
      enabled: !!flagEvent,
      refetchInterval: 30_000,
      staleTime: 15_000,
      trpc: { context: { skipBatch: true } },
    }
  );
  const flagRow = useMemo(
    () => (flagEvent && flagSummary ? { event: flagEvent, summary: flagSummary } : null),
    [flagEvent, flagSummary]
  );
  return (
    <FlagRaceContext.Provider value={flagRow}>
      <TurfSummaryProvider imageIds={imageIds} gate={gate}>
        <HatTurfCardProvider>{children}</HatTurfCardProvider>
      </TurfSummaryProvider>
    </FlagRaceContext.Provider>
  );
}

/** Mounted by the detail page with the picture on screen. */
export function HatTurfDetailReset({ imageId }: { imageId: number | undefined }) {
  const card = useHatTurfCard();
  const setDraft = card?.setDraft;
  const setPlaced = card?.setPlaced;
  useEffect(() => {
    setDraft?.(null);
    setPlaced?.(null);
  }, [imageId, setDraft, setPlaced]);
  return null;
}
