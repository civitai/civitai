import { useEffect, useRef } from 'react';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';

/**
 * Keeps the carousel and the URL's image in step. Returns the carousel's settle handler, which
 * says whether it moved the URL.
 */
export function useCarouselUrlSync({
  images,
  index,
  navigate,
  carouselNavigate,
}: {
  images: { id: number }[];
  /** The URL's image. */
  index: number;
  navigate: (imageId: number) => void;
  carouselNavigate: (index: number) => void;
}) {
  const storyline = useStorylineMode();

  // Deferred to the carousel settling rather than run per slide change: the URL
  // replace pushes a global store update that re-renders every useBrowserRouter
  // consumer, which is too much to do inside an animating frame.
  const lastSettledIdRef = useRef(images[index]?.id);
  const handleSettle = (settledIndex: number) => {
    const settled = images[settledIndex];
    // a drag that springs back settles on the slide it started from
    if (!settled || lastSettledIdRef.current === settled.id) return false;
    lastSettledIdRef.current = settled.id;
    navigate(settled.id);
    return true;
  };

  // The drawer and the fork point move the detail to another image from outside the carousel.
  // An index that only caught up with the carousel's own settle is skipped, or a quick second
  // swipe would be dragged back.
  useEffect(() => {
    const target = images[index];
    if (!storyline.active || !target || target.id === lastSettledIdRef.current) return;
    lastSettledIdRef.current = target.id;
    carouselNavigate(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on index change or mode entry
  }, [index, storyline.active]);

  // Only for the image the URL already names: any other moves the URL, and the effect above follows.
  const seekTo = useRef<(imageId: number) => void>();
  seekTo.current = (imageId) => {
    if (images[index]?.id !== imageId) return;
    lastSettledIdRef.current = imageId;
    carouselNavigate(index);
  };
  const onSeek = storyline.active ? storyline.onSeek : undefined;
  useEffect(() => onSeek?.((imageId) => seekTo.current?.(imageId)), [onSeek]);

  return handleSettle;
}
