import { describe, expect, it, vi } from 'vitest';
import {
  PATCH_WAIT_MS,
  createSnapshotService,
  type DeltaRead,
  type FullRead,
  type SnapshotDeps,
  type SnapshotStore,
} from '../tickets/snapshot-service';
import { SNAPSHOT_TIMING as T, type Snapshot, type TicketRecord } from '$lib/tickets/snapshot';

const NOW = 1_800_000_000_000;

const rec = (id: number, over: Partial<TicketRecord> = {}): TicketRecord => ({
  id: String(id),
  subject: `s${id}`,
  status: 2,
  cfFeature: null,
  tags: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-02T00:00:00Z',
  ...over,
});

const enriched = (id: number, over: Partial<TicketRecord> = {}) =>
  rec(id, { routerTopic: null, civitaiUserId: null, enrichedAt: NOW - 1, ...over });

const snapshotOf = (over: Partial<Snapshot> = {}): Snapshot => ({
  tickets: [enriched(1), enriched(2)],
  syncedAt: NOW - T.deltaMinMs - 1,
  attemptedAt: NOW - T.deltaMinMs - 1,
  fullAt: NOW - T.deltaMinMs - 1,
  needsFull: false,
  readWarnings: [],
  routerFailed: false,
  lastError: null,
  ...over,
});

/** An in-memory store whose lock can be held by "another process". */
function fakeStore(initial: Snapshot | null = null) {
  const state = {
    snapshot: initial,
    lockedBy: null as string | null,
    writes: 0,
    failure: null as { at: number; reason: string } | null,
  };
  const store: SnapshotStore = {
    read: vi.fn(async () => state.snapshot),
    write: vi.fn(async (s) => {
      state.snapshot = s;
      state.writes += 1;
    }),
    lock: vi.fn(async (token) => {
      if (state.lockedBy) return false;
      state.lockedBy = token;
      return true;
    }),
    unlock: vi.fn(async (token) => {
      if (state.lockedBy === token) state.lockedBy = null;
    }),
    readBuildFailure: vi.fn(async () => state.failure),
    writeBuildFailure: vi.fn(async (f) => {
      state.failure = f;
    }),
  };
  return { store, state };
}

type Over = Partial<Omit<SnapshotDeps, 'store'>>;

function setup(initial: Snapshot | null = null, over: Over = {}) {
  const { store, state } = fakeStore(initial);
  const clock = { now: NOW };
  const deferred: Promise<unknown>[] = [];
  const fullRead = vi.fn(
    async (): Promise<FullRead> => ({
      status: 'ok',
      tickets: [rec(1), rec(2), rec(3)],
      complete: true,
      warnings: [],
    })
  );
  const deltaRead = vi.fn(
    async (_since: string): Promise<DeltaRead> => ({ status: 'ok', changed: [], complete: true })
  );
  const enrich = vi.fn(
    async (ids: string[]) => new Map(ids.map((id) => [id, { topic: 't', civitaiUserId: 9 }]))
  );
  const service = createSnapshotService({
    store,
    fullRead,
    deltaRead,
    enrich,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    defer: (p) => {
      deferred.push(p);
    },
    ...over,
  });
  const settle = () => Promise.all(deferred.splice(0));
  return { service, store, state, clock, fullRead, deltaRead, enrich, settle };
}

describe('reading the snapshot', () => {
  it('builds one inline when none exists, enriching what it read', async () => {
    const { service, state, fullRead, enrich } = setup(null);
    const res = await service.get();
    expect(fullRead).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledWith(['1', '2', '3']);
    expect(res.status).toBe('ok');
    expect(state.snapshot).toMatchObject({
      syncedAt: NOW,
      fullAt: NOW,
      needsFull: false,
      lastError: null,
    });
    expect(
      state.snapshot?.tickets.every((t) => t.routerTopic === 't' && t.enrichedAt === NOW)
    ).toBe(true);
  });

  it('serves a fresh snapshot without touching Freshdesk or the lock', async () => {
    const { service, store, fullRead, deltaRead } = setup(snapshotOf({ attemptedAt: NOW - 1000 }));
    const res = await service.get();
    expect(res.status === 'ok' && res.snapshot.tickets).toHaveLength(2);
    expect(fullRead).not.toHaveBeenCalled();
    expect(deltaRead).not.toHaveBeenCalled();
    expect(store.lock).not.toHaveBeenCalled();
  });

  it('answers at once from a due snapshot and refreshes behind the response', async () => {
    const { service, state, deltaRead, settle } = setup(snapshotOf());
    deltaRead.mockResolvedValueOnce({
      status: 'ok',
      complete: true,
      changed: [rec(2, { status: 5 }), rec(7)],
    });
    const res = await service.get();
    expect(res.status === 'ok' && res.snapshot.tickets.map((t) => t.id)).toEqual(['1', '2']);
    expect(deltaRead).not.toHaveBeenCalled();

    await settle();
    expect(deltaRead).toHaveBeenCalledWith(
      new Date(NOW - T.deltaMinMs - 1 - T.deltaOverlapMs).toISOString()
    );
    expect(state.snapshot?.tickets.map((t) => t.id).sort()).toEqual(['1', '7']);
    expect(state.snapshot).toMatchObject({ syncedAt: NOW, attemptedAt: NOW, lastError: null });
  });

  it('starts one refresh for concurrent reads in a process', async () => {
    const { service, store, settle } = setup(snapshotOf());
    await Promise.all([service.get(), service.get(), service.get()]);
    await settle();
    expect(store.lock).toHaveBeenCalledTimes(1);
  });

  it('is unavailable, and asks Freshdesk nothing, when Redis cannot be read', async () => {
    const { service, store, fullRead } = setup(null);
    vi.mocked(store.read).mockRejectedValueOnce(new Error('redis down'));
    const res = await service.get();
    expect(res.status).toBe('unavailable');
    expect(fullRead).not.toHaveBeenCalled();
  });
});

describe('peeking at the snapshot', () => {
  it('returns a due snapshot as stored, without Freshdesk, the lock or a refresh', async () => {
    const { service, store, fullRead, deltaRead, settle } = setup(
      snapshotOf({ attemptedAt: NOW - T.fullRetryMs * 10 })
    );
    expect((await service.peek())?.tickets).toHaveLength(2);
    await settle();
    expect(fullRead).not.toHaveBeenCalled();
    expect(deltaRead).not.toHaveBeenCalled();
    expect(store.lock).not.toHaveBeenCalled();
  });

  it('returns null, and builds nothing, when there is no snapshot', async () => {
    const { service, fullRead, store } = setup(null);
    expect(await service.peek()).toBeNull();
    expect(fullRead).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });
});

describe('single flight', () => {
  it('serves the current snapshot when another process holds the lock', async () => {
    const { service, state, fullRead, deltaRead, settle } = setup(snapshotOf());
    state.lockedBy = 'someone-else';
    const res = await service.get();
    await settle();
    expect(res.status).toBe('ok');
    expect(fullRead).not.toHaveBeenCalled();
    expect(deltaRead).not.toHaveBeenCalled();
  });

  it('waits for another process that is building the first snapshot, then serves it', async () => {
    const { service, state, store, fullRead } = setup(null);
    state.lockedBy = 'builder';
    let polls = 0;
    vi.mocked(store.read).mockImplementation(async () => {
      polls += 1;
      return polls > 3 ? snapshotOf({ attemptedAt: NOW }) : null;
    });
    const res = await service.get();
    expect(res.status).toBe('ok');
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('gives up waiting for a first snapshot that never lands', async () => {
    const { service, state } = setup(null);
    state.lockedBy = 'builder';
    const res = await service.get();
    expect(res.status).toBe('unavailable');
  });

  it('re-reads inside the lock so a refresh another process just finished is not repeated', async () => {
    const { service, store, fullRead, deltaRead, settle } = setup(snapshotOf());
    vi.mocked(store.read)
      .mockResolvedValueOnce(snapshotOf())
      .mockResolvedValue(snapshotOf({ attemptedAt: NOW - 5 }));
    await service.get();
    await settle();
    expect(deltaRead).not.toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
  });

  it('releases the lock after a failure', async () => {
    const { service, state, deltaRead, settle } = setup(snapshotOf());
    deltaRead.mockRejectedValueOnce(new Error('boom'));
    await service.get();
    await settle();
    expect(state.lockedBy).toBeNull();
  });
});

describe('a refresh that cannot complete', () => {
  it('keeps the old tickets and records why when a delta fails', async () => {
    const { service, state, deltaRead, settle } = setup(snapshotOf());
    deltaRead.mockResolvedValueOnce({ status: 'unavailable', reason: 'Freshdesk returned 500.' });
    await service.get();
    await settle();
    expect(state.snapshot?.tickets.map((t) => t.id)).toEqual(['1', '2']);
    expect(state.snapshot).toMatchObject({
      lastError: 'Freshdesk returned 500.',
      attemptedAt: NOW,
      syncedAt: NOW - T.deltaMinMs - 1,
    });
  });

  it('warns about stale data once a failure has gone on past the threshold', async () => {
    const { service, state, clock, deltaRead, settle } = setup(snapshotOf());
    deltaRead.mockResolvedValue({ status: 'unavailable', reason: 'down' });
    await service.get();
    await settle();
    clock.now = state.snapshot!.syncedAt + T.staleWarnMs;
    const res = await service.get();
    expect(res.status === 'ok' && res.warnings.join(' ')).toMatch(/out of date/i);
  });

  it('merges a delta that overflowed, holds the sync point, and asks for a full rebuild', async () => {
    const { service, state, deltaRead, settle } = setup(snapshotOf());
    deltaRead.mockResolvedValueOnce({ status: 'ok', complete: false, changed: [rec(8)] });
    await service.get();
    await settle();
    expect(state.snapshot?.tickets.map((t) => t.id).sort()).toEqual(['1', '2', '8']);
    expect(state.snapshot).toMatchObject({ needsFull: true, syncedAt: NOW - T.deltaMinMs - 1 });
  });

  it('keeps the old snapshot when a full rebuild fails', async () => {
    const { service, state, fullRead, settle } = setup(
      snapshotOf({ fullAt: NOW - T.fullRebuildMs })
    );
    fullRead.mockResolvedValueOnce({ status: 'unavailable', reason: 'rate limit' });
    await service.get();
    await settle();
    expect(state.snapshot?.tickets.map((t) => t.id)).toEqual(['1', '2']);
    expect(state.snapshot?.lastError).toBe('rate limit');
  });

  it('is unavailable when the first full read fails', async () => {
    const { service, fullRead, state } = setup(null);
    fullRead.mockResolvedValueOnce({ status: 'unavailable', reason: 'rate limit' });
    const res = await service.get();
    expect(res).toEqual({ status: 'unavailable', reason: 'rate limit' });
    expect(state.snapshot).toBeNull();
    expect(state.lockedBy).toBeNull();
  });

  it('stores a first full read that came back short, with its warnings and a rebuild due', async () => {
    const { service, state, fullRead } = setup(null);
    fullRead.mockResolvedValueOnce({
      status: 'ok',
      tickets: [rec(1)],
      complete: false,
      warnings: ['Showing 1 of 9 "Open" tickets; the rest is in Freshdesk.'],
    });
    const res = await service.get();
    expect(state.snapshot).toMatchObject({ needsFull: true });
    expect(res.status === 'ok' && res.warnings).toEqual([
      'Showing 1 of 9 "Open" tickets; the rest is in Freshdesk.',
    ]);
  });

  it('adds a short full read to the old snapshot instead of dropping what it missed', async () => {
    const { service, state, fullRead, settle } = setup(
      snapshotOf({ fullAt: NOW - T.fullRebuildMs })
    );
    fullRead.mockResolvedValueOnce({
      status: 'ok',
      tickets: [rec(2, { status: 3 }), rec(5)],
      complete: false,
      warnings: ['short'],
    });
    await service.get();
    await settle();
    const byId = new Map(state.snapshot!.tickets.map((t) => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual(['1', '2', '5']);
    expect(byId.get('2')?.status).toBe(3);
    expect(state.snapshot).toMatchObject({ needsFull: true, readWarnings: ['short'] });
  });

  it('keeps a full rebuild with its router answers from the old snapshot', async () => {
    const old = snapshotOf({
      fullAt: NOW - T.fullRebuildMs,
      tickets: [enriched(1, { routerTopic: 'keep', civitaiUserId: 5 })],
    });
    const { service, state, enrich, settle } = setup(old);
    await service.get();
    await settle();
    expect(enrich).toHaveBeenCalledWith(['2', '3']);
    expect(state.snapshot?.tickets.find((t) => t.id === '1')).toMatchObject({
      routerTopic: 'keep',
      civitaiUserId: 5,
    });
  });
});

describe('a requester address', () => {
  it('never reaches the store, whichever read carried it', async () => {
    const withEmail = (id: number) => ({ ...rec(id), requesterEmail: `u${id}@example.test` });
    const { service, state, fullRead, deltaRead, settle } = setup(null);
    fullRead.mockResolvedValueOnce({
      status: 'ok',
      tickets: [withEmail(1), withEmail(2)],
      complete: true,
      warnings: [],
    });
    await service.get();
    expect(JSON.stringify(state.snapshot)).not.toContain('example.test');

    state.snapshot = snapshotOf();
    deltaRead.mockResolvedValueOnce({ status: 'ok', complete: true, changed: [withEmail(7)] });
    await service.get();
    await settle();
    expect(state.snapshot?.tickets.map((t) => t.id)).toContain('7');
    await service.patch(withEmail(8));
    expect(JSON.stringify(state.snapshot)).not.toContain('example.test');
  });
});

describe('the first build failing', () => {
  it('is not retried by every request: the failure is recorded and the retry interval respected', async () => {
    const { service, state, clock, fullRead } = setup(null);
    fullRead.mockResolvedValue({ status: 'unavailable', reason: 'Freshdesk returned 429.' });
    const first = await service.get();
    expect(first).toMatchObject({ status: 'unavailable' });
    expect(state.failure).toMatchObject({ at: NOW, reason: 'Freshdesk returned 429.' });

    clock.now += T.fullRetryMs - 1000;
    const second = await service.get();
    expect(fullRead).toHaveBeenCalledTimes(1);
    expect(second.status === 'unavailable' && second.reason).toMatch(/429/);
    expect(state.lockedBy).toBeNull();
  });

  it('builds again once the retry interval has passed, and a success is stored', async () => {
    const { service, state, clock, fullRead } = setup(null);
    fullRead.mockResolvedValueOnce({ status: 'unavailable', reason: 'down' });
    await service.get();
    clock.now += T.fullRetryMs;
    const res = await service.get();
    expect(fullRead).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('ok');
    expect(state.snapshot).not.toBeNull();
  });

  it('records a build that threw as well', async () => {
    const { service, state, fullRead } = setup(null);
    fullRead.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await service.get();
    expect(state.failure).toMatchObject({ reason: 'boom' });
  });

  it('tells a reader waiting on another process about the failure it left, instead of waiting it out', async () => {
    const { service, state, clock } = setup(null);
    state.lockedBy = 'builder';
    state.failure = { at: clock.now, reason: 'Freshdesk returned 429.' };
    const res = await service.get();
    expect(res.status === 'unavailable' && res.reason).toMatch(/429/);
    expect(clock.now).toBe(NOW);
  });
});

describe('full reads that keep coming back short', () => {
  it('lets a ticket that closed leave once enough short reads have not listed it', async () => {
    const { service, state, clock, fullRead } = setup(
      snapshotOf({ fullAt: NOW - T.fullRebuildMs })
    );
    fullRead.mockResolvedValue({
      status: 'ok',
      tickets: [rec(2)],
      complete: false,
      warnings: ['short'],
    });
    for (let i = 0; i < T.maxMissedFulls; i++) {
      expect(state.snapshot?.tickets.map((t) => t.id).sort()).toEqual(['1', '2']);
      await service.refresh();
      clock.now += T.fullRetryMs;
    }
    expect(state.snapshot?.tickets.map((t) => t.id)).toEqual(['2']);
    expect(state.snapshot?.needsFull).toBe(true);
  });
});

describe('enrichment', () => {
  it('never fails the refresh, and says the router was not read', async () => {
    const { service, state, enrich } = setup(null);
    enrich.mockRejectedValueOnce(new Error('clickhouse down'));
    const res = await service.get();
    expect(res.status).toBe('ok');
    expect(state.snapshot?.routerFailed).toBe(true);
    expect(state.snapshot?.tickets).toHaveLength(3);
    expect(res.status === 'ok' && res.warnings.join(' ')).toMatch(/router/i);
  });

  it('asks again on the next refresh for tickets it could not enrich', async () => {
    const { service, state, enrich, clock, settle } = setup(null);
    enrich.mockRejectedValueOnce(new Error('down'));
    await service.get();
    clock.now += T.deltaMinMs;
    await service.get();
    await settle();
    expect(enrich).toHaveBeenCalledTimes(2);
    expect(state.snapshot?.routerFailed).toBe(false);
  });

  it('asks only about tickets the router has not answered for', async () => {
    const { service, enrich, settle } = setup(snapshotOf());
    await service.get();
    await settle();
    expect(enrich).not.toHaveBeenCalled();
  });
});

describe('patching one ticket after a write', () => {
  it('replaces the ticket and leaves the sync metadata alone', async () => {
    const before = snapshotOf();
    const { service, state } = setup(before);
    await service.patch(enriched(2, { status: 3, tags: ['sent-to-support'] }));
    expect(state.snapshot?.tickets.find((t) => t.id === '2')).toMatchObject({
      status: 3,
      tags: ['sent-to-support'],
    });
    expect(state.snapshot).toMatchObject({
      syncedAt: before.syncedAt,
      attemptedAt: before.attemptedAt,
      fullAt: before.fullAt,
    });
  });

  it('returns what it held for the ticket before, with its router answer', async () => {
    const { service } = setup(
      snapshotOf({ tickets: [enriched(2, { routerTopic: 'nsfw-moderation' })] })
    );
    const before = await service.patch(rec(2, { status: 3 }));
    expect(before).toMatchObject({ id: '2', status: 2, routerTopic: 'nsfw-moderation' });
    expect(await service.patch(rec(99))).toBeUndefined();
  });

  it('removes a ticket that is no longer live', async () => {
    const { service, state } = setup(snapshotOf());
    await service.patch(rec(2, { status: 4 }));
    expect(state.snapshot?.tickets.map((t) => t.id)).toEqual(['1']);
  });

  it('adds a live ticket the snapshot did not hold', async () => {
    const { service, state } = setup(snapshotOf());
    await service.patch(rec(9));
    expect(state.snapshot?.tickets.map((t) => t.id)).toContain('9');
  });

  it('takes the lock for the write and releases it', async () => {
    const { service, state, store } = setup(snapshotOf());
    await service.patch(rec(2, { status: 3 }));
    expect(store.lock).toHaveBeenCalledTimes(1);
    expect(state.lockedBy).toBeNull();
  });

  it('waits briefly for a refresh holding the lock, then applies the patch', async () => {
    let onSleep: () => void = () => {};
    const { service, state } = setup(snapshotOf(), {
      sleep: async () => onSleep(),
    });
    state.lockedBy = 'refresh';
    let sleeps = 0;
    onSleep = () => {
      sleeps += 1;
      if (sleeps === 2) state.lockedBy = null;
    };
    await service.patch(rec(2, { status: 3 }));
    expect(state.snapshot?.tickets.find((t) => t.id === '2')?.status).toBe(3);
  });

  it('gives up without writing when the lock stays busy: the next delta covers the ticket', async () => {
    const clock = { now: NOW };
    const { service, state } = setup(snapshotOf(), {
      now: () => clock.now,
      sleep: async (ms) => {
        clock.now += ms;
      },
    });
    state.lockedBy = 'refresh';
    const before = state.snapshot;
    await expect(service.patch(rec(2, { status: 3 }))).resolves.toMatchObject({ id: '2' });
    expect(state.writes).toBe(0);
    expect(state.snapshot).toBe(before);
    expect(clock.now - NOW).toBeGreaterThanOrEqual(PATCH_WAIT_MS);
    expect(clock.now - NOW).toBeLessThanOrEqual(PATCH_WAIT_MS + 1000);
  });

  it('does not overwrite a refresh that lands while it waits', async () => {
    let onSleep: () => Promise<void> = async () => {};
    const { service, state, deltaRead } = setup(snapshotOf(), {
      sleep: () => onSleep(),
    });
    let release!: () => void;
    deltaRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'ok', complete: true, changed: [rec(7)] });
        })
    );
    const refreshing = service.refresh();
    await vi.waitFor(() => expect(deltaRead).toHaveBeenCalled());
    // The refresh finishes while the patch waits for its lock.
    onSleep = async () => {
      release();
      await refreshing;
    };
    await service.patch(rec(2, { status: 3 }));
    expect(state.snapshot?.tickets.map((t) => t.id).sort()).toEqual(['1', '2', '7']);
    expect(state.snapshot?.tickets.find((t) => t.id === '2')?.status).toBe(3);
    expect(state.snapshot?.syncedAt).toBe(NOW);
  });

  it('does nothing without a snapshot, and never throws when the store fails', async () => {
    const { service, state, store } = setup(null);
    await service.patch(rec(2));
    expect(state.writes).toBe(0);
    vi.mocked(store.read).mockRejectedValueOnce(new Error('down'));
    await expect(service.patch(rec(2))).resolves.toBeUndefined();
  });
});
