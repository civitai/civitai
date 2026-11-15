/**
 * One watch mark set for the whole page, shared by every TurfSummaryProvider on it for the same event
 * (the `hatTurfBatchedCalls` flag). Without it each provider, one per home block or feed, keeps its
 * own set, its own 30s re-mark and its own scroll-burst spacing, so a page with several blocks sends
 * several `hatTurf.watch` calls per interval, and their scroll marks share one per-caller rate limit
 * without knowing of each other. With it the page sends the union of its on-screen ids, at most
 * MAX_IDS_PER_MARK per call, once per interval.
 *
 * Same timing rules as the per-provider watcher (TurfSummaryProvider's TurfWatcher): new ids go out
 * together after a short wait and at most once per `minGapMs`; the whole set is re-marked every
 * `refreshMs`. Plain timers and an injected `send`, so it is testable without React.
 */

/** The `imageIds` cap on `watchTurfImagesSchema` (MAX_TURF_IMAGES_PER_MARK on the server). */
export const MAX_IDS_PER_MARK = 50;

export type TurfWatchHubOptions = {
  event: string;
  send: (input: { event: string; imageIds: number[] }) => void;
  /** Re-mark interval for the whole set. Must stay under the server's mark lifetime. */
  refreshMs: number;
  /** Ids added within this window go out in one mark. */
  coalesceMs: number;
  /** A mark of new ids waits at least this long after the previous one. */
  minGapMs: number;
  now?: () => number;
};

export class TurfWatchHub {
  readonly event: string;
  private readonly options: Required<Omit<TurfWatchHubOptions, 'event'>>;
  private readonly counts = new Map<number, number>();
  private marked = new Set<number>();
  private readonly everMarked = new Set<number>();
  private readonly listeners = new Set<(imageIds: number[]) => void>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private lastFlushSent = -Infinity;

  constructor({ event, now = () => Date.now(), ...rest }: TurfWatchHubOptions) {
    this.event = event;
    this.options = { ...rest, now };
    this.refreshTimer = setInterval(() => {
      const all = [...this.counts.keys()];
      if (all.length) this.send(all);
    }, rest.refreshMs);
  }

  /** One more card on screen shows this image. */
  retain(imageId: number) {
    this.counts.set(imageId, (this.counts.get(imageId) ?? 0) + 1);
    this.schedule();
  }

  /** One card fewer on screen shows this image. */
  release(imageId: number) {
    const left = (this.counts.get(imageId) ?? 1) - 1;
    if (left <= 0) this.counts.delete(imageId);
    else this.counts.set(imageId, left);
    this.schedule();
  }

  /** Hears the ids marked again after a gap (watched, then not, then again), for their catch-up. */
  subscribe(listener: (imageIds: number[]) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The ids on screen now, in the order they were first retained. */
  watched() {
    return [...this.counts.keys()];
  }

  dispose() {
    clearTimeout(this.flushTimer);
    clearInterval(this.refreshTimer);
    this.flushTimer = undefined;
    this.listeners.clear();
  }

  private send(ids: number[]) {
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_MARK)
      this.options.send({ event: this.event, imageIds: ids.slice(i, i + MAX_IDS_PER_MARK) });
  }

  private schedule() {
    if (this.flushTimer) return;
    const { coalesceMs, minGapMs, now } = this.options;
    const wait = Math.max(coalesceMs, this.lastFlushSent + minGapMs - now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const current = [...this.counts.keys()];
      const added = current.filter((id) => !this.marked.has(id));
      this.marked = new Set(current);
      if (!added.length) return;
      this.lastFlushSent = now();
      this.send(added);
      const again = added.filter((id) => this.everMarked.has(id));
      added.forEach((id) => this.everMarked.add(id));
      if (again.length) this.listeners.forEach((listener) => listener(again));
    }, wait);
  }
}

/**
 * The page's hubs, one per event, shared by refcount: the first provider to retain one creates it,
 * the last to release it stops its timers. Browser only (retained from effects).
 */
const hubs = new Map<string, { hub: TurfWatchHub; refs: number }>();

export function retainTurfWatchHub(options: TurfWatchHubOptions) {
  let entry = hubs.get(options.event);
  if (!entry) {
    entry = { hub: new TurfWatchHub(options), refs: 0 };
    hubs.set(options.event, entry);
  }
  entry.refs += 1;
  const held = entry;
  let released = false;
  return {
    hub: held.hub,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      held.hub.dispose();
      if (hubs.get(options.event) === held) hubs.delete(options.event);
    },
  };
}
