/**
 * The DELAYED-COMMIT approval queue behind "Approve & next" on the per-submission review page.
 *
 * "Approve & next" does not call `approveRequest` at click time. It records a PENDING approval
 * here, the page moves straight on to the next submission, and a toast counts down "Approving
 * <name> in 10s — Undo". Undo inside the window cancels the entry and NOTHING is sent; otherwise
 * the entry's `commit` runs once when the timer fires.
 *
 * 🔴 FRAMEWORK-FREE AND SINGLETON-SHAPED ON PURPOSE. The queue has to outlive the component that
 * enqueued it — the click that records an approval is also the click that navigates away from
 * that component — so it cannot live in React state. It lives in a module-level instance
 * (`reviewApprovalQueue`, below) for the lifetime of the SPA, which is what "the pending queue
 * lives at the review LAYOUT level" means in a pages-router app where each review page is a
 * separate page component. Several approvals can be pending at once (approve, next, approve, …).
 *
 * 🔴 THE TRANSPORT IS INJECTED. Each entry carries its own `commit` closure (built by the caller
 * from the tRPC client), and timers come in through `options.timers`, so the five behaviours the
 * brief requires are pinned in the node tier with fake timers rather than through a browser:
 *   1. undo within the window sends nothing;
 *   2. no undo sends exactly once;
 *   3. navigation WITHIN the review area keeps the timer;
 *   4. leaving the review area (route change, `pagehide`, `visibilitychange:hidden`) commits
 *      every pending entry immediately;
 *   5. a double click cannot approve twice — an id that is pending, committing or committed is
 *      refused by `enqueue`.
 * (`__tests__/pendingApprovalQueue.test.ts`.)
 *
 * A FAILED commit is not retried silently: the entry moves to `failed`, its id is released so a
 * Retry (or a fresh approve) can enqueue it again, and `onFailed` is told so the caller can raise
 * a persistent error toast and re-open the request.
 */

export const PENDING_APPROVAL_DELAY_MS = 10_000;

export type PendingApprovalStatus = 'pending' | 'committing' | 'committed' | 'failed';

export type PendingApprovalInput = {
  /** The publish-request id. The dedup key: one approval per request, ever, per session. */
  id: string;
  /** Human label for the toast ("my-app v1.2.0"). */
  label: string;
  /** Sends the approval. Called at most once per successful enqueue. */
  commit: () => Promise<unknown>;
};

export type PendingApprovalEntry = PendingApprovalInput & {
  status: PendingApprovalStatus;
  /** Epoch ms at which the timer fires. */
  dueAt: number;
  error?: unknown;
};

export type PendingApprovalEvent =
  | { type: 'enqueued'; entry: PendingApprovalEntry }
  | { type: 'undone'; entry: PendingApprovalEntry }
  | { type: 'committing'; entry: PendingApprovalEntry }
  | { type: 'committed'; entry: PendingApprovalEntry }
  | { type: 'failed'; entry: PendingApprovalEntry };

export type QueueTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
};

const defaultTimers: QueueTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export type PendingApprovalQueue = ReturnType<typeof createPendingApprovalQueue>;

export function createPendingApprovalQueue(
  options: { delayMs?: number; timers?: QueueTimers } = {}
) {
  const delayMs = options.delayMs ?? PENDING_APPROVAL_DELAY_MS;
  const timers = options.timers ?? defaultTimers;
  const entries = new Map<string, PendingApprovalEntry>();
  const handles = new Map<string, unknown>();
  const listeners = new Set<(_event: PendingApprovalEvent) => void>();
  // A stable snapshot for `useSyncExternalStore`: rebuilt on every change, never mutated.
  let snapshot: readonly PendingApprovalEntry[] = [];

  function emit(event: PendingApprovalEvent) {
    snapshot = Array.from(entries.values()).map((e) => ({ ...e }));
    for (const l of listeners) l(event);
  }

  async function run(id: string) {
    const entry = entries.get(id);
    // Only a PENDING entry may commit. This is what makes a timer firing after an explicit
    // `commitAll` (or the reverse) a no-op rather than a second send.
    if (!entry || entry.status !== 'pending') return;
    const handle = handles.get(id);
    if (handle !== undefined) timers.clearTimeout(handle);
    handles.delete(id);
    entry.status = 'committing';
    emit({ type: 'committing', entry: { ...entry } });
    try {
      await entry.commit();
      entry.status = 'committed';
      emit({ type: 'committed', entry: { ...entry } });
    } catch (error) {
      entry.status = 'failed';
      entry.error = error;
      // Released: a failed approval is retryable, so its id must not stay locked.
      entries.delete(id);
      emit({ type: 'failed', entry: { ...entry } });
    }
  }

  return {
    /**
     * Record a pending approval. Returns `false` (and does nothing) when this id already has an
     * approval pending, in flight or committed — the double-click guard.
     */
    enqueue(input: PendingApprovalInput): boolean {
      if (entries.has(input.id)) return false;
      const entry: PendingApprovalEntry = {
        ...input,
        status: 'pending',
        dueAt: timers.now() + delayMs,
      };
      entries.set(input.id, entry);
      handles.set(
        input.id,
        timers.setTimeout(() => void run(input.id), delayMs)
      );
      emit({ type: 'enqueued', entry: { ...entry } });
      return true;
    },

    /** Cancel a still-pending approval. `true` only when it was cancelled before any send. */
    undo(id: string): boolean {
      const entry = entries.get(id);
      if (!entry || entry.status !== 'pending') return false;
      const handle = handles.get(id);
      if (handle !== undefined) timers.clearTimeout(handle);
      handles.delete(id);
      entries.delete(id);
      emit({ type: 'undone', entry: { ...entry, status: 'pending' } });
      return true;
    },

    /** Commit every pending approval NOW (leaving the review area / the app). */
    commitAll(): Promise<void> {
      const ids = Array.from(entries.values())
        .filter((e) => e.status === 'pending')
        .map((e) => e.id);
      return Promise.all(ids.map((id) => run(id))).then(() => undefined);
    },

    /** Commit one pending approval now (a failed approval's Retry). */
    commitNow(id: string): Promise<void> {
      return run(id);
    },

    /** Ids with an approval pending or in flight — the ones the queue page should not offer. */
    activeIds(): Set<string> {
      return new Set(
        Array.from(entries.values())
          .filter((e) => e.status === 'pending' || e.status === 'committing')
          .map((e) => e.id)
      );
    },

    hasPending(): boolean {
      return Array.from(entries.values()).some((e) => e.status === 'pending');
    },

    get(id: string): PendingApprovalEntry | undefined {
      const e = entries.get(id);
      return e ? { ...e } : undefined;
    },

    getSnapshot(): readonly PendingApprovalEntry[] {
      return snapshot;
    },

    subscribe(listener: (e: PendingApprovalEvent) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Is `url` (a path, optionally with query/hash, or an absolute URL) inside `/apps/review`? */
export function isInReviewArea(url: string): boolean {
  let path = url;
  try {
    // An absolute URL (or one Next hands back with a basePath) — keep only the path.
    if (/^[a-z]+:\/\//i.test(url)) path = new URL(url).pathname;
  } catch {
    /* keep the raw string */
  }
  path = path.split(/[?#]/)[0];
  return path === '/apps/review' || path.startsWith('/apps/review/');
}

type RouterEventsLike = {
  on: (event: 'routeChangeStart', handler: (url: string) => void) => void;
  off: (event: 'routeChangeStart', handler: (url: string) => void) => void;
};

type WindowLike = Pick<Window, 'addEventListener' | 'removeEventListener'>;
type DocumentLike = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;

/**
 * Wire the queue to the ways a moderator can leave:
 *  - a client-side route change to anywhere OUTSIDE `/apps/review` commits everything now
 *    (a change between review pages — including the full-page preview — keeps the timers);
 *  - `pagehide` and `visibilitychange` → hidden commit everything now (closing the tab, or
 *    switching away from it, ends the undo window: the browser may never run the timer).
 *    🔴 A send started from `pagehide` is cancelled with the page unless it is a `keepalive`
 *    request, so an entry's `commit` must use one — the review page's does (`trpcKeepalive`);
 *  - `beforeunload` asks the browser to warn while anything is still pending.
 * Returns the unbind function. Idempotent per (queue, targets) only via the caller.
 */
export function bindPendingApprovalLifecycle(
  queue: Pick<PendingApprovalQueue, 'commitAll' | 'hasPending'>,
  targets: { routerEvents: RouterEventsLike; win: WindowLike; doc: DocumentLike }
): () => void {
  const onRoute = (url: string) => {
    if (!isInReviewArea(url)) void queue.commitAll();
  };
  const onPageHide = () => void queue.commitAll();
  const onVisibility = () => {
    if (targets.doc.visibilityState === 'hidden') void queue.commitAll();
  };
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!queue.hasPending()) return;
    e.preventDefault();
    // Legacy browsers only show the prompt when returnValue is set.
    e.returnValue = '';
  };
  targets.routerEvents.on('routeChangeStart', onRoute);
  targets.win.addEventListener('pagehide', onPageHide);
  targets.win.addEventListener('beforeunload', onBeforeUnload);
  targets.doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    targets.routerEvents.off('routeChangeStart', onRoute);
    targets.win.removeEventListener('pagehide', onPageHide);
    targets.win.removeEventListener('beforeunload', onBeforeUnload);
    targets.doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/** The app-lifetime instance the review pages share. */
export const reviewApprovalQueue = createPendingApprovalQueue();
