import {
  applyEnrichment,
  carryOver,
  decideRefresh,
  deltaSince,
  mergeDelta,
  needsEnrichment,
  snapshotWarnings,
  type ChangedTicket,
  type RefreshKind,
  type Snapshot,
  type TicketRecord,
} from '$lib/tickets/snapshot';

export type SnapshotStore = {
  read(): Promise<Snapshot | null>;
  write(snapshot: Snapshot): Promise<void>;
  /** Takes the refresh lock for `token`; false when another process holds it. */
  lock(token: string): Promise<boolean>;
  /** Releases the lock only if `token` still holds it. */
  unlock(token: string): Promise<void>;
};

type Unavailable = { status: 'unavailable'; reason: string };

export type FullRead =
  | { status: 'ok'; tickets: TicketRecord[]; complete: boolean; warnings: string[] }
  | Unavailable;

export type DeltaRead = { status: 'ok'; changed: ChangedTicket[]; complete: boolean } | Unavailable;

export type RouterAnswer = { topic: string | null; civitaiUserId: number | null };

export type SnapshotDeps = {
  store: SnapshotStore;
  fullRead: () => Promise<FullRead>;
  deltaRead: (sinceIso: string) => Promise<DeltaRead>;
  enrich: (ids: string[]) => Promise<Map<string, RouterAnswer>>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Hands a background refresh to the runtime; tests collect it to await. */
  defer?: (work: Promise<unknown>) => void;
};

export type SnapshotRead =
  | { status: 'ok'; snapshot: Snapshot; warnings: string[] }
  | { status: 'unavailable'; reason: string };

type Refreshed =
  | { status: 'ok'; snapshot: Snapshot }
  | { status: 'busy' }
  | { status: 'unavailable'; reason: string };

/** How long a reader with no snapshot waits for another process that is building the first one. */
export const WAIT_FOR_BUILD_MS = 20_000;
const WAIT_POLL_MS = 500;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unavailable = (reason: string): Unavailable => ({ status: 'unavailable', reason });

/**
 * The shared snapshot of live tickets and how it is kept current.
 *
 * Reads never wait on Freshdesk once a snapshot exists: a due refresh runs behind the response
 * (stale-while-revalidate, safe because the app runs on a long-lived Node server), under a Redis lock
 * so only one process refreshes at a time and the rest serve what is stored. Only the very first
 * build is awaited. A refresh that fails keeps the old tickets and records why.
 */
export function createSnapshotService(deps: SnapshotDeps) {
  const { store, fullRead, deltaRead, enrich } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const defer = deps.defer ?? ((work: Promise<unknown>) => void work);
  let inflight: Promise<unknown> | null = null;

  const guarded = async <T extends Unavailable | { status: 'ok' }>(read: () => Promise<T>) => {
    try {
      return await read();
    } catch (e) {
      console.error('[tickets] snapshot read failed', e);
      return unavailable(errorMessage(e));
    }
  };

  /** Asks the router about the tickets that need it. A failure leaves them to the next refresh. */
  async function enrichAll(tickets: TicketRecord[], at: number) {
    const ids = tickets.filter((t) => needsEnrichment(t, at)).map((t) => t.id);
    if (ids.length === 0) return { tickets, routerFailed: false };
    try {
      const answers = await enrich(ids);
      const asked = new Set(ids);
      return {
        tickets: tickets.map((t) =>
          asked.has(t.id) ? applyEnrichment(t, answers.get(t.id), at) : t
        ),
        routerFailed: false,
      };
    } catch (e) {
      console.error('[tickets] router context failed', e);
      return { tickets, routerFailed: true };
    }
  }

  async function runFull(current: Snapshot | null): Promise<Refreshed> {
    const startedAt = now();
    const res = await guarded(fullRead);
    if (res.status !== 'ok') {
      if (!current) return res;
      return {
        status: 'ok',
        snapshot: { ...current, attemptedAt: startedAt, lastError: res.reason },
      };
    }
    // A short read must not drop the tickets it missed: it can only add and update.
    const read =
      res.complete || !current
        ? carryOver(current?.tickets ?? [], res.tickets)
        : mergeDelta(current.tickets, res.tickets);
    const { tickets, routerFailed } = await enrichAll(read, startedAt);
    return {
      status: 'ok',
      snapshot: {
        tickets,
        syncedAt: startedAt,
        attemptedAt: startedAt,
        fullAt: res.complete || !current ? startedAt : current.fullAt,
        needsFull: !res.complete,
        readWarnings: res.warnings,
        routerFailed,
        lastError: null,
      },
    };
  }

  async function runDelta(current: Snapshot): Promise<Refreshed> {
    const startedAt = now();
    const res = await guarded(() => deltaRead(deltaSince(current.syncedAt)));
    if (res.status !== 'ok')
      return {
        status: 'ok',
        snapshot: { ...current, attemptedAt: startedAt, lastError: res.reason },
      };
    const { tickets, routerFailed } = await enrichAll(
      mergeDelta(current.tickets, res.changed),
      startedAt
    );
    // An overflowed delta holds the sync point: what it did not read is older than what it did, and
    // only a full rebuild is certain to find it.
    return {
      status: 'ok',
      snapshot: res.complete
        ? {
            ...current,
            tickets,
            syncedAt: startedAt,
            attemptedAt: startedAt,
            needsFull: false,
            routerFailed,
            lastError: null,
          }
        : {
            ...current,
            tickets,
            attemptedAt: startedAt,
            needsFull: true,
            routerFailed,
            lastError: 'Too many tickets changed to read as a delta.',
          },
    };
  }

  /** One refresh under the lock; `busy` when another process holds it. Always releases the lock. */
  async function refresh(): Promise<Refreshed> {
    const token = `${now()}-${Math.random().toString(36).slice(2)}`;
    let held: boolean;
    try {
      held = await store.lock(token);
    } catch (e) {
      console.error('[tickets] snapshot lock failed', e);
      return unavailable('The ticket cache could not be reached.');
    }
    if (!held) return { status: 'busy' };
    try {
      // Another process may have refreshed between the caller's read and the lock.
      const current = await store.read();
      const kind = decideRefresh(current, now());
      if (kind === 'none' && current) return { status: 'ok', snapshot: current };
      const next = kind === 'delta' && current ? await runDelta(current) : await runFull(current);
      if (next.status === 'ok') await store.write(next.snapshot);
      return next;
    } catch (e) {
      console.error('[tickets] snapshot refresh failed', e);
      return unavailable(errorMessage(e));
    } finally {
      await store.unlock(token).catch((e) => console.error('[tickets] snapshot unlock failed', e));
    }
  }

  const answer = (snapshot: Snapshot): SnapshotRead => ({
    status: 'ok',
    snapshot,
    warnings: snapshotWarnings(snapshot, now()),
  });

  async function waitForFirstBuild(): Promise<SnapshotRead> {
    const deadline = now() + WAIT_FOR_BUILD_MS;
    while (now() < deadline) {
      await sleep(WAIT_POLL_MS);
      try {
        const snapshot = await store.read();
        if (snapshot) return answer(snapshot);
      } catch {
        break;
      }
    }
    return unavailable('Tickets are still being read from Freshdesk. Reload in a moment.');
  }

  function refreshBehindResponse() {
    if (inflight) return;
    const run = refresh().then(
      () => undefined,
      () => undefined
    );
    inflight = run.finally(() => {
      inflight = null;
    });
    defer(inflight);
  }

  return {
    /** The snapshot with the warnings to show above it. Awaits Freshdesk only when there is none yet. */
    async get(): Promise<SnapshotRead> {
      let snapshot: Snapshot | null;
      try {
        snapshot = await store.read();
      } catch (e) {
        // Not "fail open": building without the cache or its lock would spend the shared rate limit on every read.
        console.error('[tickets] snapshot read failed', e);
        return unavailable('The ticket cache could not be read.');
      }
      if (snapshot) {
        if (decideRefresh(snapshot, now()) !== 'none') refreshBehindResponse();
        return answer(snapshot);
      }
      const built = await refresh();
      if (built.status === 'ok') return answer(built.snapshot);
      return built.status === 'busy' ? waitForFirstBuild() : built;
    },

    /** Awaited refresh, for callers that need the outcome. */
    refresh,

    /**
     * Brings one ticket up to date after the app changed or read it, or drops it once it is no longer
     * live. Returns what the snapshot held for it before. Best-effort and not locked: a refresh that
     * races it re-reads the ticket on the next delta.
     */
    async patch(ticket: TicketRecord): Promise<TicketRecord | undefined> {
      try {
        const snapshot = await store.read();
        if (!snapshot) return undefined;
        await store.write({ ...snapshot, tickets: mergeDelta(snapshot.tickets, [ticket]) });
        return snapshot.tickets.find((t) => t.id === ticket.id);
      } catch (e) {
        console.error('[tickets] snapshot patch failed', e);
        return undefined;
      }
    },
  };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;
export type { RefreshKind };
