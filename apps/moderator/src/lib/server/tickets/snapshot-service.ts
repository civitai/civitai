import {
  applyEnrichment,
  carryOver,
  SNAPSHOT_TIMING,
  decideRefresh,
  deltaSince,
  mergeDelta,
  mergeShortRead,
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
  /** Newest failed first build, shared so attempts are spaced across processes. */
  readBuildFailure(): Promise<BuildFailure | null>;
  writeBuildFailure(failure: BuildFailure): Promise<void>;
};

export type BuildFailure = { at: number; reason: string };

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
/** How long a patch waits for a refresh to release the lock before leaving the ticket to the next delta. */
export const PATCH_WAIT_MS = 2_000;
const PATCH_POLL_MS = 200;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const unavailable = (reason: string): Unavailable => ({ status: 'unavailable', reason });

/** Refreshes run behind the response under a Redis lock (stale-while-revalidate; safe only because the app is a long-lived Node server). Only the first build is awaited. */
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

  /** A router failure leaves the tickets unenriched for the next refresh. */
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
        snapshot: {
          ...current,
          attemptedAt: startedAt,
          fullFailedAt: startedAt,
          lastError: res.reason,
        },
      };
    }
    const read =
      res.complete || !current
        ? carryOver(current?.tickets ?? [], res.tickets)
        : mergeShortRead(current.tickets, res.tickets);
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

  /** Throws when the store cannot be reached. */
  async function acquire(token: string, waitMs: number, pollMs: number): Promise<boolean> {
    const deadline = now() + waitMs;
    while (!(await store.lock(token))) {
      if (now() >= deadline) return false;
      await sleep(pollMs);
    }
    return true;
  }

  const newToken = () => `${now()}-${Math.random().toString(36).slice(2)}`;

  const releaseLock = (token: string) =>
    store.unlock(token).catch((e) => console.error('[tickets] snapshot unlock failed', e));

  /** The recorded failure of the first build while it is recent enough that Freshdesk should be left alone. */
  async function recentBuildFailure(): Promise<Unavailable | null> {
    const failure = await store.readBuildFailure().catch(() => null);
    if (!failure) return null;
    const waitMs = SNAPSHOT_TIMING.fullRetryMs - (now() - failure.at);
    if (waitMs <= 0) return null;
    const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
    return unavailable(
      `Freshdesk could not be read (${failure.reason}). The next attempt is in about ${minutes} min.`
    );
  }

  async function refresh(): Promise<Refreshed> {
    const token = newToken();
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
      if (!current) {
        const recent = await recentBuildFailure();
        if (recent) return recent;
      }
      const next = kind === 'delta' && current ? await runDelta(current) : await runFull(current);
      if (next.status === 'ok') await store.write(next.snapshot);
      else if (next.status === 'unavailable' && !current) await recordBuildFailure(next.reason);
      return next;
    } catch (e) {
      console.error('[tickets] snapshot refresh failed', e);
      const reason = errorMessage(e);
      await recordBuildFailure(reason);
      return unavailable(reason);
    } finally {
      await releaseLock(token);
    }
  }

  async function recordBuildFailure(reason: string) {
    await store
      .writeBuildFailure({ at: now(), reason })
      .catch((e) => console.error('[tickets] build failure not recorded', e));
  }

  const answer = (snapshot: Snapshot): SnapshotRead => ({
    status: 'ok',
    snapshot,
    warnings: snapshotWarnings(snapshot, now()),
  });

  async function waitForFirstBuild(): Promise<SnapshotRead> {
    const deadline = now() + WAIT_FOR_BUILD_MS;
    while (now() < deadline) {
      const failed = await recentBuildFailure();
      if (failed) return failed;
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
    /** The stored snapshot as it is, with no refresh and no Freshdesk call; null when there is none. */
    peek(): Promise<Snapshot | null> {
      return store.read();
    },

    /** The snapshot with warnings. Awaits Freshdesk only when none is stored yet. */
    async get(): Promise<SnapshotRead> {
      let snapshot: Snapshot | null;
      try {
        snapshot = await store.read();
      } catch (e) {
        // No fallback to building: without the cache or its lock every read would spend the shared Freshdesk rate limit.
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

    refresh,

    /** Returns the ticket's previous record. Writes under the refresh lock so it cannot overwrite a refresh that landed in between; if the lock stays busy for `PATCH_WAIT_MS` the patch is skipped and the next delta picks the ticket up. */
    async patch(ticket: TicketRecord): Promise<TicketRecord | undefined> {
      const token = newToken();
      let held = false;
      try {
        held = await acquire(token, PATCH_WAIT_MS, PATCH_POLL_MS);
        const snapshot = await store.read();
        if (!snapshot) return undefined;
        const before = snapshot.tickets.find((t) => t.id === ticket.id);
        if (!held) return before;
        await store.write({ ...snapshot, tickets: mergeDelta(snapshot.tickets, [ticket]) });
        return before;
      } catch (e) {
        console.error('[tickets] snapshot patch failed', e);
        return undefined;
      } finally {
        if (held) await releaseLock(token);
      }
    },
  };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;
export type { RefreshKind };
