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
/** Hats read per image. */
const STICKERS_PER_IMAGE = 5;
/** At most 50 images per mark call. Re-marked every 30s; must stay under TURF_WATCH_TTL_MS. */
const WATCH_BATCH = 50;
const WATCH_REFRESH_MS = 30_000;
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
 * Standings and hats for every image on a surface, fetched once for the ids on it: one request per
 * 100 cards for each, never one per card (tRPC request batching is off by default, so a per-card
 * query is a per-card HTTP request). Chunked in arrival order, not sorted, for the reason
 * `StickerPlacementBatchProvider` gives. Pushes can be missed, so a remount after 30s stale rereads
 * the page.
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
  const summaryStamp = summaryQueries.map((query) => query.dataUpdatedAt).join(',');
  const stickerStamp = stickerQueries.map((query) => query.dataUpdatedAt).join(',');

  // A push or re-read applies over the page's read only while it is newer than that image's chunk,
  // so loading another chunk never wipes what pushes brought to the chunks already on screen.
  const [pushed, setPushed] = useState<Record<number, Pushed>>({});
  const [reread, setReread] = useState<Record<number, { at: number; stickers: HatSticker[] }>>({});

  const chunkOf = useMemo(() => {
    const map = new Map<number, number>();
    chunks.forEach((chunk, index) => chunk.forEach((id) => map.set(id, index)));
    return map;
  }, [chunks]);

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
          if (read)
            setReread((current) => ({
              ...current,
              [imageId]: { at: Date.now(), stickers: read[imageId] ?? [] },
            }));
        }, STICKER_REFRESH_DEBOUNCE_MS)
      );
    },
    [event, utils]
  );
  useEffect(() => {
    const timers = refreshTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  const onPush = useCallback(
    (raw: unknown) => {
      const push = event ? readTurfPush(raw, event) : null;
      if (!push) return;
      setPushed((current) => ({ ...current, [push.imageId]: { ...push, at: Date.now() } }));
      refresh(push.imageId);
    },
    [event, refresh]
  );

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

  const value = useMemo<TurfSummaries | null>(() => {
    if (!event) return null;
    const stampOf = (queries: { dataUpdatedAt: number }[], imageId: number) =>
      queries[chunkOf.get(imageId) ?? -1]?.dataUpdatedAt ?? 0;
    let images = base.images;
    for (const push of Object.values(pushed))
      if (push.at > stampOf(summaryQueries, push.imageId))
        images = applyTurfPush(images, push.imageId, push.counts);
    const stickers = { ...baseStickers };
    for (const [id, read] of Object.entries(reread))
      if (read.at > stampOf(stickerQueries, Number(id))) stickers[Number(id)] = read.stickers;
    return { event, team: base.team, images, open: base.open, stickers, watch };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, base, pushed, baseStickers, reread, watch, summaryStamp, stickerStamp, chunkOf]);

  return (
    <TurfSummaryContext.Provider value={value}>
      {event && (
        <>
          <TurfPushes onPush={onPush} />
          <TurfWatcher event={event} watching={watching} version={watchVersion} />
        </>
      )}
      {children}
    </TurfSummaryContext.Provider>
  );
}

type Pushed = NonNullable<ReturnType<typeof readTurfPush>> & { at: number };

/** Mounted only with Hat Turf on, so the signals hub isn't required otherwise. */
function TurfPushes({ onPush }: { onPush: (raw: unknown) => void }) {
  useSignalConnection(SignalMessages.EventPointsTurf, onPush);
  return null;
}

/** New cards are marked at once; the whole set is re-marked on the interval. */
function TurfWatcher({
  event,
  watching,
  version,
}: {
  event: string;
  watching: React.MutableRefObject<Map<number, number>>;
  version: number;
}) {
  const { mutate: mark } = trpc.hatTurf.watch.useMutation();
  const marked = useRef(new Set<number>());
  const send = useCallback(
    (ids: number[]) => {
      for (let i = 0; i < ids.length; i += WATCH_BATCH)
        mark({ event, imageIds: ids.slice(i, i + WATCH_BATCH) });
    },
    [event, mark]
  );

  useEffect(() => {
    const current = [...watching.current.keys()];
    const added = current.filter((id) => !marked.current.has(id));
    marked.current = new Set(current);
    if (added.length) send(added);
  }, [version, watching, send]);

  useEffect(() => {
    const timer = setInterval(() => {
      const all = [...watching.current.keys()];
      if (all.length) send(all);
    }, WATCH_REFRESH_MS);
    return () => clearInterval(timer);
  }, [watching, send]);

  return null;
}

/** The feed context: the event and the viewer's team. Null when Hat Turf is off here. */
export const useTurfFeed = () => useContext(TurfSummaryContext);

/** One image's standings, or undefined: no hats on it yet, not loaded, or Hat Turf is off. */
export function useTurfSummary(imageId: number): TurfSummary | undefined {
  return useContext(TurfSummaryContext)?.images[imageId];
}
