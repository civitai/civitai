/**
 * Shared by every TurfSummaryProvider on the page for one event (hatTurfBatchedCalls), so several
 * blocks send one mark set instead of one call each and share one scroll-burst spacing. A failed
 * mark is retried once. A hidden page sends no re-marks; becoming visible re-marks everything once
 * the marks may have lapsed, because a lapsed mark misses pushes that nothing re-reads.
 */
import { MAX_TURF_IMAGES_PER_MARK } from '~/server/schema/turf.schema';
import { chunkIds } from '~/utils/array-helpers';
import { backoffDelay } from '~/utils/backoff';

/**
 * Must stay under half of TURF_WATCH_TTL_MS (turf-watch.ts), so one missed re-mark does not lapse
 * the marks. Pinned by turf-watch-hub.test.ts.
 */
export const BATCHED_WATCH_REFRESH_MS = 40_000;
export const BATCHED_WATCH_RETRY_MS = 5_000;
export const BATCHED_WATCH_RETRY_JITTER_MS = 1_000;

export type TurfWatchHubOptions = {
  event: string;
  /** One mark call. A rejected promise is retried once. */
  send: (input: { event: string; imageIds: number[] }) => Promise<unknown> | void;
  /** Re-mark interval for the whole set. Must stay under the server's mark lifetime. */
  refreshMs: number;
  /** Ids added within this window go out in one mark. */
  coalesceMs: number;
  /** A mark of new ids waits at least this long after the previous one. */
  minGapMs: number;
  /** A failed mark is sent again once, this long after (plus jitter). */
  retryMs: number;
  retryJitterMs: number;
  /** How long the server keeps one mark (TURF_WATCH_TTL_MS), for marks made by another call. */
  markLifetimeMs: number;
  now?: () => number;
  /** Calls back when the page becomes visible; returns the way to stop. Defaults to `document`. */
  onVisible?: (callback: () => void) => () => void;
  /** Whether the page is hidden now, so the interval sends nothing. Defaults to `document`. */
  isHidden?: () => boolean;
};

const documentVisible = (callback: () => void) => {
  if (typeof document === 'undefined') return () => undefined;
  const listener = () => {
    if (document.visibilityState === 'visible') callback();
  };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

const documentHidden = () =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

export class TurfWatchHub {
  readonly event: string;
  private readonly options: Required<Omit<TurfWatchHubOptions, 'event' | 'onVisible'>>;
  /** Until when another call (a summaries read) has marked an id, so the hub need not yet. */
  private readonly markedElsewhere = new Map<number, number>();
  private readonly counts = new Map<number, number>();
  private marked = new Set<number>();
  private readonly everMarked = new Set<number>();
  private readonly listeners = new Set<(imageIds: number[]) => void>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly stopVisible: () => void;
  private lastFlushSent = -Infinity;
  /** When the whole set was last sent (an interval tick or a resume). */
  private lastAllSent = -Infinity;
  private nextTickAt: number;
  private disposed = false;

  constructor({
    event,
    now = () => Date.now(),
    onVisible = documentVisible,
    isHidden = documentHidden,
    ...rest
  }: TurfWatchHubOptions) {
    this.event = event;
    this.options = { ...rest, now, isHidden };
    this.nextTickAt = now() + rest.refreshMs;
    this.refreshTimer = setInterval(() => {
      this.nextTickAt = now() + rest.refreshMs;
      this.markAll();
    }, rest.refreshMs);
    this.stopVisible = onVisible(() => this.resume());
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

  /**
   * Hears ids to catch up: those marked again after a gap (watched, then not, then again), and every
   * watched id when the page becomes visible again after its marks may have lapsed (resume).
   */
  subscribe(listener: (imageIds: number[]) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The ids on screen now, in the order they were first retained. */
  watched() {
    return [...this.counts.keys()];
  }

  /**
   * Another call has just marked these ids (a joined viewer's summaries read, at `at`): an id coming
   * on screen while that mark outlives the next two interval ticks needs no mark of its own, the same
   * margin of one missed re-mark the hub keeps for its own marks.
   */
  noteMarked(imageIds: number[], at: number) {
    const now = this.options.now();
    this.markedElsewhere.forEach((until, id) => {
      if (until <= now) this.markedElsewhere.delete(id);
    });
    const until = at + this.options.markLifetimeMs;
    if (until <= now) return;
    for (const id of imageIds)
      if ((this.markedElsewhere.get(id) ?? 0) < until) this.markedElsewhere.set(id, until);
  }

  /**
   * Back on screen: if an interval re-mark may have been missed meanwhile (skipped while hidden, or
   * the page's timers frozen), re-mark the whole set now and have every provider catch up what it
   * shows. Shown again sooner, the marks are still live and the next tick renews them.
   */
  resume() {
    const all = this.watched();
    if (!all.length) return;
    if (this.options.now() - this.lastAllSent < this.options.refreshMs) return;
    this.lastAllSent = this.options.now();
    this.send(all);
    this.notify(all);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.flushTimer);
    clearInterval(this.refreshTimer);
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    this.stopVisible();
    this.flushTimer = undefined;
    this.listeners.clear();
  }

  private markAll() {
    // A hidden page re-marks nothing: becoming visible re-marks what has lapsed (resume).
    if (this.options.isHidden()) return;
    const all = this.watched();
    if (!all.length) return;
    this.lastAllSent = this.options.now();
    this.send(all);
  }

  private notify(ids: number[]) {
    this.listeners.forEach((listener) => listener(ids));
  }

  private send(ids: number[]) {
    for (const imageIds of chunkIds(ids, MAX_TURF_IMAGES_PER_MARK))
      this.sendOne({ event: this.event, imageIds }, true);
  }

  private sendOne(input: { event: string; imageIds: number[] }, retry: boolean) {
    let sent: Promise<unknown> | void;
    try {
      sent = this.options.send(input);
    } catch (error) {
      sent = Promise.reject(error);
    }
    if (!sent) return;
    sent.catch(() => {
      if (!retry || this.disposed) return;
      const { retryMs, retryJitterMs } = this.options;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        if (!this.disposed) this.sendOne(input, false);
      }, backoffDelay(0, { baseMs: retryMs, jitterMs: retryJitterMs }));
      this.retryTimers.add(timer);
    });
  }

  private schedule() {
    if (this.flushTimer) return;
    const { coalesceMs, minGapMs, now, refreshMs } = this.options;
    const wait = Math.max(coalesceMs, this.lastFlushSent + minGapMs - now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      const current = [...this.counts.keys()];
      const added = current.filter((id) => !this.marked.has(id));
      this.marked = new Set(current);
      if (!added.length) return;
      // Marked elsewhere for long enough that two interval ticks renew it before it lapses.
      const covered = this.nextTickAt + refreshMs;
      const unmarked = added.filter((id) => (this.markedElsewhere.get(id) ?? 0) <= covered);
      if (unmarked.length) {
        this.lastFlushSent = now();
        this.send(unmarked);
      }
      const again = added.filter((id) => this.everMarked.has(id));
      added.forEach((id) => this.everMarked.add(id));
      if (again.length) this.notify(again);
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
