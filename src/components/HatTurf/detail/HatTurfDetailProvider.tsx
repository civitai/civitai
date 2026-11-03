import { useEffect, useMemo } from 'react';
import { HatTurfCardProvider, useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { TurfSummaryProvider } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfDetail } from '~/components/HatTurf/detail/useHatTurfDetail';

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
  return (
    <TurfSummaryProvider imageIds={imageIds} gate={gate}>
      <HatTurfCardProvider>{children}</HatTurfCardProvider>
    </TurfSummaryProvider>
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
