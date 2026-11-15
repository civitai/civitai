/**
 * Shared by every TurfSummaryProvider on the page for one event (hatTurfBatchedCalls), so several
 * blocks send one mark set instead of one call each and share one scroll-burst spacing. A failed
 * mark is retried once, and a page becoming visible re-marks everything, because a lapsed mark
 * misses pushes that nothing re-reads.
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
  now?: () => number;
  /** Calls back when the page becomes visible; returns the way to stop. Defaults to `document`. */
  onVisible?: (callback: () => void) => () => void;
};

const documentVisible = (callback: () => void) => {
  if (typeof document === 'undefined') return () => undefined;
  const listener = () => {
    if (document.visibilityState === 'visible') callback();
  };
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};

export class TurfWatchHub {
  readonly event: string;
  private readonly options: Required<Omit<TurfWatchHubOptions, 'event' | 'onVisible'>>;
  private readonly counts = new Map<number, number>();
  private marked = new Set<number>();
  private readonly everMarked = new Set<number>();
  private readonly listeners = new Set<(imageIds: number[]) => void>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly stopVisible: () => void;
  private lastFlushSent = -Infinity;
  private disposed = false;

  constructor({
    event,
    now = () => Date.now(),
    onVisible = documentVisible,
    ...rest
  }: TurfWatchHubOptions) {
    this.event = event;
    this.options = { ...rest, now };
    this.refreshTimer = setInterval(() => this.markAll(), rest.refreshMs);
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
   * watched id when the page becomes visible again.
   */
  subscribe(listener: (imageIds: number[]) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The ids on screen now, in the order they were first retained. */
  watched() {
    return [...this.counts.keys()];
  }

  /** Back on screen: re-mark the whole set now, and have every provider catch up what it shows. */
  resume() {
    const all = this.watched();
    if (!all.length) return;
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
    const all = this.watched();
    if (all.length) this.send(all);
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
