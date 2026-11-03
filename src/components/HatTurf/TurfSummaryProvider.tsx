import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useHatTurfFeed } from '~/components/HatTurf/useHatTurfFeed';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { applyTurfPush, readTurfPush } from '~/components/HatTurf/hat-turf.utils';
import type { HatSticker, TurfSummary } from '~/components/HatTurf/hat-turf.utils';
import { SignalMessages } from '~/server/common/enums';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

/** Matches the `imageIds` cap on `turfSummariesSchema`. */
const SUMMARY_CHUNK = 100;
/** Hats read per image: the latest of each team first, then by recency. */
const STICKERS_PER_IMAGE = 5;
/** A client marks the images it has on screen, at most 50 per call, and again before 90s lapse. */
const WATCH_BATCH = 50;
const WATCH_REFRESH_MS = 30_000;
/** A burst of placements on one image is read back once. */
const STICKER_REFRESH_DEBOUNCE_MS = 800;

export type TurfSummaries = {
  event: string;
  /** The viewer's team, or null (signed out, or not in the event). */
  team: string | null;
  images: Record<number, TurfSummary>;
  /** Per requested image: published, visible and its owner opted in, so it can take a hat now. */
  open: Record<number, boolean>;
  stickers: Record<number, HatSticker[]>;
  /** A card on screen says so: its count changes are pushed. Returns the way to stop. */
  watch: (imageId: number) => () => void;
};

export const TurfSummaryContext = createContext<TurfSummaries | null>(null);

/**
 * Hat Turf standings and hats for every image on a surface, fetched once for the ids on it: a feed
 * pays one request per 100 cards for each, never one per card (tRPC request batching is off by
 * default, so a per-card query is a per-card HTTP request). Chunked in arrival order, not sorted,
 * for the reason `StickerPlacementBatchProvider` gives: a feed appends older ids, and sorting would
 * refetch every earlier chunk on each page.
 *
 * Live: cards in view are marked as watched, and a push for one replaces its counts here and reads
 * that image's hats back once. A later read of the page (30s stale, or window focus) is the
 * fallback when pushes are down.
 *
 * Renders its children bare, and asks nothing, when Hat Turf is not on for this viewer.
 */
export function TurfSummaryProvider({
  imageIds,
  children,
}: {
  imageIds: number[];
  children: React.ReactNode;
}) {
  const gate = useHatTurfFeed();
  const event = gate?.event;
  const utils = trpc.useUtils();

  const chunks = useMemo(
    () => (event ? chunkIds(imageIds, SUMMARY_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(','), event]
  );

  const summaryQueries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.hatTurf.getSummaries({ event: event ?? '', imageIds: chunk }, { staleTime: 30_000 })
    )
  );
  const stickerQueries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.hatTurf.getStickersForImages(
        { event: event ?? '', imageIds: chunk, perImage: STICKERS_PER_IMAGE },
        { staleTime: 30_000 }
      )
    )
  );
  // Change stamps rather than the query arrays, which are new on every render.
  const summaryStamp = summaryQueries.map((query) => query.dataUpdatedAt).join(',');
  const stickerStamp = stickerQueries.map((query) => query.dataUpdatedAt).join(',');

  const [pushed, setPushed] = useState<Record<number, ReturnType<typeof readTurfPush>>>({});
  const [reread, setReread] = useState<Record<number, HatSticker[]>>({});
  // A fresh read of the page is newer than any push before it.
  useEffect(() => setPushed({}), [summaryStamp]);
  useEffect(() => setReread({}), [stickerStamp]);

  const base = useMemo(() => {
    let team: string | null = null;
    const images: Record<number, TurfSummary> = {};
    const open: Record<number, boolean> = {};
    for (const query of summaryQueries) {
      if (!query.data) continue;
      team = query.data.team ?? team;
      Object.assign(images, query.data.images);
      Object.assign(open, query.data.open);
    }
    return { team, images, open };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryStamp]);

  const baseStickers = useMemo(() => {
    const stickers: Record<number, HatSticker[]> = {};
    for (const query of stickerQueries) Object.assign(stickers, query.data);
    return stickers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickerStamp]);

  const refreshTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const refresh = useCallback(
    (imageId: number) => {
      if (!event) return;
      clearTimeout(refreshTimers.current.get(imageId));
      refreshTimers.current.set(
        imageId,
        setTimeout(async () => {
          const read = await utils.hatTurf.getStickersForImages
            .fetch({ event, imageIds: [imageId], perImage: STICKERS_PER_IMAGE })
            .catch(() => null);
          if (read) setReread((current) => ({ ...current, [imageId]: read[imageId] ?? [] }));
        }, STICKER_REFRESH_DEBOUNCE_MS)
      );
    },
    [event, utils]
  );
  useEffect(() => {
    const timers = refreshTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  useSignalConnection(SignalMessages.EventPointsTurf, (raw: unknown) => {
    const push = event ? readTurfPush(raw, event) : null;
    if (!push) return;
    setPushed((current) => ({ ...current, [push.imageId]: push }));
    refresh(push.imageId);
  });

  const watching = useRef(new Map<number, number>());
  const [watchVersion, setWatchVersion] = useState(0);
  const watch = useCallback((imageId: number) => {
    watching.current.set(imageId, (watching.current.get(imageId) ?? 0) + 1);
    setWatchVersion((v) => v + 1);
    return () => {
      const left = (watching.current.get(imageId) ?? 1) - 1;
      if (left <= 0) watching.current.delete(imageId);
      else watching.current.set(imageId, left);
      setWatchVersion((v) => v + 1);
    };
  }, []);

  const { mutate: mark } = trpc.hatTurf.watch.useMutation();
  useEffect(() => {
    if (!event) return;
    const ids = [...watching.current.keys()];
    if (!ids.length) return;
    const send = () => {
      for (let i = 0; i < ids.length; i += WATCH_BATCH)
        mark({ event, imageIds: ids.slice(i, i + WATCH_BATCH) });
    };
    send();
    const timer = setInterval(send, WATCH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [event, mark, watchVersion]);

  const value = useMemo<TurfSummaries | null>(() => {
    if (!event) return null;
    let images = base.images;
    for (const push of Object.values(pushed))
      if (push) images = applyTurfPush(images, push.imageId, push.counts);
    return {
      event,
      team: base.team,
      images,
      open: base.open,
      stickers: { ...baseStickers, ...reread },
      watch,
    };
  }, [event, base, pushed, baseStickers, reread, watch]);

  return <TurfSummaryContext.Provider value={value}>{children}</TurfSummaryContext.Provider>;
}

/** The feed context: the event and the viewer's team. Null when Hat Turf is off here. */
export const useTurfFeed = () => useContext(TurfSummaryContext);

/** One image's standings, or undefined: no hats on it yet, not loaded, or Hat Turf is off. */
export function useTurfSummary(imageId: number): TurfSummary | undefined {
  return useContext(TurfSummaryContext)?.images[imageId];
}
