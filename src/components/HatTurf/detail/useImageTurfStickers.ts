import { useEffect, useRef, useState } from 'react';
import { useTurfFeed, useTurfSummary } from '~/components/HatTurf/TurfSummaryProvider';
import type { HatSticker } from '~/components/HatTurf/hat-turf.utils';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

type Cursor = { createdAt: string; id: string };

/**
 * One picture's hats to draw on image detail: the latest the server will render, plus the
 * viewer's own, then older pages on request. Counts arrive by push; a change in them rereads the
 * first page, debounced, and keeps the older pages already loaded.
 */
export function useImageTurfStickers(imageId: number) {
  const feed = useTurfFeed();
  const summary = useTurfSummary(imageId);
  const utils = trpc.useUtils();
  const { data, refetch } = trpc.hatTurf.getImageStickers.useQuery(
    { event: feed?.event ?? '', imageId },
    { enabled: !!feed, staleTime: 30_000 }
  );
  const [older, setOlder] = useState<{ stickers: HatSticker[]; cursor: Cursor | null } | null>(
    null
  );
  const [loading, setLoading] = useState(false);

  const total = summary ? Object.values(summary.shown).reduce((a, b) => a + b, 0) : 0;
  const lastTotal = useRef(total);
  useEffect(() => {
    if (lastTotal.current === total) return;
    lastTotal.current = total;
    const timer = setTimeout(() => void refetch(), 800);
    return () => clearTimeout(timer);
  }, [total, refetch]);

  const nextCursor: Cursor | null = older ? older.cursor : data?.nextCursor ?? null;
  const loadMore = async () => {
    if (!feed || !nextCursor || loading) return;
    setLoading(true);
    try {
      const page = await utils.hatTurf.getImageStickers.fetch({
        event: feed.event,
        imageId,
        before: nextCursor,
      });
      setOlder((current) => ({
        stickers: [...(current?.stickers ?? []), ...page.stickers],
        cursor: page.nextCursor,
      }));
    } catch (error) {
      showErrorNotification({ title: "Couldn't load more hats", error: error as Error });
    } finally {
      setLoading(false);
    }
  };

  let stickers: HatSticker[] | undefined;
  // The viewer's own hat, kept out of the pages: it is drawn whatever the limit.
  const own = data?.mine ?? undefined;
  if (data) {
    const seen = new Set(data.stickers.map((sticker) => String(sticker.id)));
    if (own) seen.add(String(own.id));
    stickers = [
      ...data.stickers.filter((s) => !own || String(s.id) !== String(own.id)),
      ...(older?.stickers ?? []).filter((s) => !seen.has(String(s.id))),
    ];
  }
  return {
    stickers,
    own,
    drawCeiling: data?.drawCeiling,
    loadMore: nextCursor ? loadMore : undefined,
    loading,
  };
}
