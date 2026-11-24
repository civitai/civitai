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
  carouselIndex,
  carouselNavigate,
}: {
  /** The slides, keyed `img:<id>` / `txt:<id>`. */
  items: { key: string }[];
  /** The URL's slide. */
  index: number;
  /** Point the URL at the slide at this index. */
  navigate: (index: number) => void;
  /** The carousel's slide. */
  carouselIndex: number;
  carouselNavigate: (index: number) => void;
}) {
  const storyline = useStorylineMode();

  // Deferred to the carousel settling rather than run per slide change: the URL
  // replace pushes a global store update that re-renders every useBrowserRouter
  // consumer, which is too much to do inside an animating frame.
  const lastSettledKeyRef = useRef(items[index]?.key);
  // The list the effect below last moved the carousel for, so the re-key further down defers to it.
  const movedForItemsRef = useRef<typeof items>();
  const handleSettle = (settledIndex: number) => {
    const settled = items[settledIndex];
    // a drag that springs back settles on the slide it started from
    if (!settled || lastSettledKeyRef.current === settled.key) return false;
    lastSettledKeyRef.current = settled.key;
    navigate(settledIndex);
    return true;
  };

  // The drawer, the fork point and a cold `?text=` load (the text arrives after the carousel has
  // mounted on its anchor image) move the detail to another slide from outside the carousel.
  // An index that only caught up with the carousel's own settle is skipped, or a quick second
  // swipe would be dragged back.
  useEffect(() => {
    const target = items[index];
    const hasTexts = items.some((item) => item.key.startsWith('txt:'));
    if (!(storyline.active || hasTexts) || !target || target.key === lastSettledKeyRef.current)
      return;
    lastSettledKeyRef.current = target.key;
    movedForItemsRef.current = items;
    carouselNavigate(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on index change or mode entry
  }, [index, storyline.active]);

  // The carousel's index is a slide number, so a slide inserted or removed before it (a cold load's
  // text arriving ahead of the open image) would move the carousel onto a different slide. Keep it
  // on the slide it showed. Skipped when the carousel moved in the same commit, or the effect above
  // sent it to the URL's slide for this list: that move wins.
  const shownRef = useRef({ items, carouselIndex });
  useEffect(() => {
    const shown = shownRef.current;
    shownRef.current = { items, carouselIndex };
    if (shown.items === items || shown.carouselIndex !== carouselIndex) return;
    if (movedForItemsRef.current === items) return;
    const key = shown.items[carouselIndex]?.key;
    const at = key ? items.findIndex((item) => item.key === key) : -1;
    if (at > -1 && at !== carouselIndex) carouselNavigate(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on a new list or a carousel move
  }, [items, carouselIndex]);

  // Only for the slide the URL already names: any other moves the URL, and the effect above follows.
  const seekTo = useRef<(key: string) => void>();
  seekTo.current = (key) => {
    if (items[index]?.key !== key) return;
    lastSettledKeyRef.current = key;
    carouselNavigate(index);
  };
  const onSeek = storyline.active ? storyline.onSeek : undefined;
  useEffect(() => onSeek?.((key) => seekTo.current?.(key)), [onSeek]);

  return handleSettle;
}
