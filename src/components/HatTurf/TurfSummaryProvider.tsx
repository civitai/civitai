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
import type { HatTurfFeedArm } from '~/components/HatTurf/useHatTurfFeed';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { applyTurfPush, readTurfPush } from '~/components/HatTurf/hat-turf.utils';
import type { HatSticker, TurfSummary } from '~/components/HatTurf/hat-turf.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages } from '~/server/common/enums';
import { TURF_FEED_STICKERS } from '~/server/schema/turf.schema';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

/** Matches the `imageIds` cap on `turfSummariesSchema`. */
const SUMMARY_CHUNK = 100;
/** At most 50 images per mark call. Re-marked every 30s; must stay under TURF_WATCH_TTL_MS. */
const WATCH_BATCH = 50;
const WATCH_REFRESH_MS = 30_000;
// Cards mount a few at a time while scrolling; their marks go out together.
const WATCH_COALESCE_MS = 250;
// Only for a push that carries no stickers (an older server): every viewer of a hot image reads, so
// each reads at most this often per image, spread so they do not arrive together.
const STICKER_REREAD_MIN_MS = 10_000;
const STICKER_REREAD_JITTER_MS = 750;

export type TurfSummaries = {
  event: string;
  /** The viewer's `hatTurfFeedCard` arm; null on a surface outside that experiment (image detail). */
  arm: HatTurfFeedArm | null;
  /** The viewer's team, or null (signed out, or not in the event). */
  team: string | null;
  /**
   * The viewer opted in to Hat Turf. Only a joined viewer sees turf: hats, counts and pushes. Anyone
   * else gets the join invite and nothing drawn.
   */
  joined: boolean;
  images: Record<number, TurfSummary>;
  /** Per requested image: published and visible, so it can take a hat now. */
  open: Record<number, boolean>;
  /** Contest entries: no Hat Turf on them at all. */
  hidden?: Record<number, boolean>;
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
  gate: gateOverride,
  children,
}: {
  imageIds: number[];
  /** Another surface's own gate (image detail has its own flag); omitted, the feed gate decides. */
  gate?: { event: string } | null;
  children: React.ReactNode;
}) {
  const feedGate = useHatTurfFeed();
  const gate = gateOverride === undefined ? feedGate : gateOverride;
  const event = gate?.event;
  const arm = gateOverride === undefined ? feedGate?.arm ?? null : null;
  const utils = trpc.useUtils();
  const user = useCurrentUser();
  // The same query as useHatStock, so the two share one cache entry.
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event: event ?? '' },
    { enabled: !!event && !!user, staleTime: 30_000 }
  );
  const joined = !!user && stock?.optedIn === true;

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
    (joined ? chunks : []).map((chunk) =>
      t.hatTurf.getStickersForImages(
        { event: event ?? '', imageIds: chunk, perImage: TURF_FEED_STICKERS },
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
    const hidden: Record<number, boolean> = {};
    for (const query of summaryQueries) {
      if (!query.data) continue;
      team = query.data.team ?? team;
      Object.assign(images, query.data.images);
      Object.assign(open, query.data.open);
      Object.assign(hidden, query.data.hidden);
    }
    return { team, images, open, hidden };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryStamp]);

  const baseStickers = useMemo(() => {
    const stickers: Record<number, HatSticker[]> = {};
    for (const query of stickerQueries) Object.assign(stickers, query.data);
    return stickers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickerStamp]);

  const refreshTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const lastReread = useRef(new Map<number, number>());
  const refresh = useCallback(
    (imageId: number) => {
      if (!event || refreshTimers.current.has(imageId)) return;
      const wait = Math.max(
        0,
        (lastReread.current.get(imageId) ?? -Infinity) + STICKER_REREAD_MIN_MS - Date.now()
      );
      refreshTimers.current.set(
        imageId,
        setTimeout(async () => {
          refreshTimers.current.delete(imageId);
          const started = Date.now();
          lastReread.current.set(imageId, started);
          const read = await utils.hatTurf.getStickersForImages
            .fetch({ event, imageIds: [imageId], perImage: TURF_FEED_STICKERS })
            .catch(() => null);
          if (read)
            setReread((current) =>
              // A push that landed while this was in flight is newer than it.
              (current[imageId]?.at ?? 0) > started
                ? current
                : { ...current, [imageId]: { at: Date.now(), stickers: read[imageId] ?? [] } }
            );
        }, wait + Math.random() * STICKER_REREAD_JITTER_MS)
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
      const at = Date.now();
      const { imageId, stickers } = push;
      setPushed((current) => ({ ...current, [imageId]: { ...push, at } }));
      if (stickers === undefined) return refresh(imageId);
      if (stickers === null) return;
      clearTimeout(refreshTimers.current.get(imageId));
      refreshTimers.current.delete(imageId);
      setReread((current) => ({ ...current, [imageId]: { at, stickers } }));
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
      if (!base.hidden[push.imageId] && push.at > stampOf(summaryQueries, push.imageId))
        images = applyTurfPush(images, push.imageId, push.counts);
    const stickers = { ...baseStickers };
    for (const [id, read] of Object.entries(reread))
      if (read.at > stampOf(stickerQueries, Number(id))) stickers[Number(id)] = read.stickers;
    for (const id of Object.keys(base.hidden)) delete stickers[Number(id)];
    return {
      event,
      arm,
      team: base.team,
      joined,
      images: joined ? images : {},
      open: base.open,
      hidden: base.hidden,
      stickers: joined ? stickers : {},
      watch,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    event,
    arm,
    joined,
    base,
    pushed,
    baseStickers,
    reread,
    watch,
    summaryStamp,
    stickerStamp,
    chunkOf,
  ]);

  return (
    <TurfSummaryContext.Provider value={value}>
      {event && joined && (
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

/** Mounted only for a joined viewer, so the signals hub isn't required otherwise. */
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

  const flush = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (flush.current) return;
    flush.current = setTimeout(() => {
      flush.current = undefined;
      const current = [...watching.current.keys()];
      const added = current.filter((id) => !marked.current.has(id));
      marked.current = new Set(current);
      if (added.length) send(added);
    }, WATCH_COALESCE_MS);
  }, [version, watching, send]);
  useEffect(() => () => clearTimeout(flush.current), []);

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
