import { useEffect, useRef } from 'react';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import type { HatSticker } from '~/components/HatTurf/hat-turf.utils';
import { trpc } from '~/utils/trpc';

/**
 * One picture's hats to draw on image detail: the latest the server will render, plus the
 * viewer's own. Counts arrive by push; a change in them rereads the hats, debounced.
 */
export function useImageTurfStickers(imageId: number) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const { data, refetch } = trpc.hatTurf.getImageStickers.useQuery(
    { event: feed?.event ?? '', imageId },
    { enabled: !!feed, staleTime: 30_000 }
  );
  const total = summary ? Object.values(summary.shown).reduce((a, b) => a + b, 0) : 0;
  const lastTotal = useRef(total);
  useEffect(() => {
    if (lastTotal.current === total) return;
    lastTotal.current = total;
    const timer = setTimeout(() => void refetch(), 800);
    return () => clearTimeout(timer);
  }, [total, refetch]);

  const stickers: HatSticker[] | undefined = data
    ? data.mine && !data.stickers.some((sticker) => sticker.id === data.mine?.id)
      ? [...data.stickers, data.mine]
      : data.stickers
    : undefined;
  return { stickers };
}
