import { useEffect, useRef } from 'react';
import { useStorylineMode } from '~/components/Storyline/StorylineModeProvider';

/**
 * Keeps the carousel and the URL's slide in step. Returns the carousel's settle handler, which
 * says whether it moved the URL.
 */
export function useCarouselUrlSync({
  items,
  index,
  navigate,
  carouselNavigate,
}: {
  /** The slides, keyed `img:<id>` / `txt:<id>`. */
  items: { key: string }[];
  /** The URL's slide. */
  index: number;
  /** Point the URL at the slide at this index. */
  navigate: (index: number) => void;
  carouselNavigate: (index: number) => void;
}) {
  const storyline = useStorylineMode();

  // Deferred to the carousel settling rather than run per slide change: the URL
  // replace pushes a global store update that re-renders every useBrowserRouter
  // consumer, which is too much to do inside an animating frame.
  const lastSettledKeyRef = useRef(items[index]?.key);
  const handleSettle = (settledIndex: number) => {
    const settled = items[settledIndex];
    // a drag that springs back settles on the slide it started from
    if (!settled || lastSettledKeyRef.current === settled.key) return false;
    lastSettledKeyRef.current = settled.key;
    navigate(settledIndex);
    return true;
  };

  // The drawer and the fork point move the detail to another image from outside the carousel.
  // An index that only caught up with the carousel's own settle is skipped, or a quick second
  // swipe would be dragged back.
  useEffect(() => {
    const target = items[index];
    if (!storyline.active || !target || target.key === lastSettledKeyRef.current) return;
    lastSettledKeyRef.current = target.key;
    carouselNavigate(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on index change or mode entry
  }, [index, storyline.active]);

  // Only for the image the URL already names: any other moves the URL, and the effect above follows.
  const seekTo = useRef<(imageId: number) => void>();
  seekTo.current = (imageId) => {
    if (items[index]?.key !== `img:${imageId}`) return;
    lastSettledKeyRef.current = items[index].key;
    carouselNavigate(index);
  };
  const onSeek = storyline.active ? storyline.onSeek : undefined;
  useEffect(() => onSeek?.((imageId) => seekTo.current?.(imageId)), [onSeek]);

  return handleSettle;
}
