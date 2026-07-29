// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The batcher-integration suites import from the hook, which pulls in these
// modules at load time — mock them so importing doesn't crash. The persistence
// module itself imports NEITHER; the pure/persistence suites don't touch them.
const queryMock = vi.fn<(input: { modelIds: number[] }) => Promise<Record<string, number[]>>>();
vi.mock('~/utils/trpc', () => ({
  trpcVanilla: {
    user: { getEngagedModelsByIds: { query: (input: { modelIds: number[] }) => queryMock(input) } },
  },
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 1 }) }));

import { useEngagedModelsStore } from '~/store/engaged-models.store';
import { applyFavoriteToggled, applyNotifyToggled } from '~/store/engaged-models.optimistic';
import {
  ENGAGED_PERSIST_STORAGE_KEY,
  ENGAGED_PERSIST_SCHEMA_VERSION,
  parseBlob,
  selectFresh,
  buildBlob,
  initEngagedModelsPersistence,
  flushEngagedModelsPersistence,
  __resetEngagedModelsPersistenceForTests,
  __setEngagedPersistConfigForTests,
  type PersistBlob,
} from '~/store/engaged-models.persist';
import {
  engagedMembershipBatcher,
  requestEngagedMembership,
  __resetEngagedMembershipBatcher,
} from '~/hooks/useEngagedModelMembership';

const store = useEngagedModelsStore;

// A blob's real TTL is 5min; use a wide window so "fresh"/"stale" is unambiguous.
const TTL = 5 * 60 * 1000;

// Map-backed localStorage stub. happy-dom 20.9 on Node ≥22 does not expose
// `window.localStorage` (native localStorage is gated behind --localstorage-file),
// so we install a deterministic stub every test. This still exercises the module's
// REAL guarded storage IO (it reads `window.localStorage`); the storage-safety
// suite overrides this with absent/throwing stubs to prove the fallbacks.
function makeStorageStub(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
  } as Storage;
}
function installStorage(): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: makeStorageStub(),
  });
}

function writeBlob(blob: PersistBlob) {
  window.localStorage.setItem(ENGAGED_PERSIST_STORAGE_KEY, JSON.stringify(blob));
}
function readBlob(): PersistBlob | null {
  return parseBlob(window.localStorage.getItem(ENGAGED_PERSIST_STORAGE_KEY));
}

beforeEach(() => {
  __resetEngagedModelsPersistenceForTests();
  store.getState().reset();
  installStorage();
  queryMock.mockReset();
  queryMock.mockResolvedValue({});
});

afterEach(() => {
  __resetEngagedModelsPersistenceForTests();
});

// ---------------------------------------------------------------------------
// Pure: parseBlob — shape validation / corruption safety
// ---------------------------------------------------------------------------
describe('parseBlob', () => {
  it('returns null for null / empty / non-JSON', () => {
    expect(parseBlob(null)).toBeNull();
    expect(parseBlob('')).toBeNull();
    expect(parseBlob('not json{')).toBeNull();
    expect(parseBlob('123')).toBeNull(); // valid JSON, wrong shape
  });

  it('rejects a schema-version mismatch', () => {
    const raw = JSON.stringify({ v: 999, userId: 1, entries: [] });
    expect(parseBlob(raw)).toBeNull();
  });

  it('rejects a missing/invalid userId or entries', () => {
    expect(parseBlob(JSON.stringify({ v: ENGAGED_PERSIST_SCHEMA_VERSION, entries: [] }))).toBeNull();
    expect(
      parseBlob(JSON.stringify({ v: ENGAGED_PERSIST_SCHEMA_VERSION, userId: 'x', entries: [] }))
    ).toBeNull();
    expect(
      parseBlob(JSON.stringify({ v: ENGAGED_PERSIST_SCHEMA_VERSION, userId: 1, entries: {} }))
    ).toBeNull();
  });

  it('parses a valid blob and drops individually-malformed entries', () => {
    const raw = JSON.stringify({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 7,
      entries: [
        { id: 10, t: ['Recommended'], at: 1000 },
        { id: -1, t: [], at: 1000 }, // bad id
        { id: 11, t: [], at: 'nope' }, // bad at
        { id: 12, t: 'notarray', at: 1000 }, // bad t
        { id: 13, t: [1, 'Notify', null], at: 1000 }, // non-string types filtered
      ],
    });
    const blob = parseBlob(raw)!;
    expect(blob.userId).toBe(7);
    expect(blob.entries.map((e) => e.id)).toEqual([10, 13]);
    expect(blob.entries[1].t).toEqual(['Notify']);
  });
});

// ---------------------------------------------------------------------------
// Pure: selectFresh — per-user isolation + TTL + reconstruction
// ---------------------------------------------------------------------------
describe('selectFresh', () => {
  const now = 1_000_000;
  const blob: PersistBlob = {
    v: ENGAGED_PERSIST_SCHEMA_VERSION,
    userId: 5,
    entries: [
      { id: 1, t: ['Recommended'], at: now },
      { id: 2, t: ['Notify', 'Mute'], at: now },
      { id: 3, t: [], at: now }, // known-not-engaged
    ],
  };

  it('returns null for a null blob', () => {
    expect(selectFresh(null, 5, now, TTL)).toBeNull();
  });

  it('returns null when the blob belongs to a DIFFERENT user (isolation)', () => {
    expect(selectFresh(blob, 6, now, TTL)).toBeNull();
  });

  it('reconstructs the endpoint-shaped record + queriedIds for the matching user', () => {
    const sel = selectFresh(blob, 5, now, TTL)!;
    expect(sel.queriedIds.sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(sel.record.Recommended).toEqual([1]);
    expect(sel.record.Notify).toEqual([2]);
    expect(sel.record.Mute).toEqual([2]);
    expect(sel.fetchedAt).toEqual([
      [1, now],
      [2, now],
      [3, now],
    ]);
  });

  it('drops ids older than the TTL (they will be re-queried)', () => {
    const mixed: PersistBlob = {
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 5,
      entries: [
        { id: 1, t: ['Recommended'], at: now }, // fresh
        { id: 2, t: ['Notify'], at: now - TTL - 1 }, // stale
      ],
    };
    const sel = selectFresh(mixed, 5, now, TTL)!;
    expect(sel.queriedIds).toEqual([1]);
    expect(sel.record.Notify).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pure: buildBlob — stale drop + size cap / eviction
// ---------------------------------------------------------------------------
describe('buildBlob', () => {
  const now = 1_000_000;

  it('serializes membership with per-id timestamps and drops stale ids', () => {
    const queried = new Set([1, 2]);
    const membership = { 1: new Set(['Recommended'] as const), 2: new Set(['Notify'] as const) };
    const fetchedAt = new Map([
      [1, now],
      [2, now - TTL - 1], // stale — not persisted
    ]);
    const blob = buildBlob(5, queried, membership as never, fetchedAt, now, TTL, 100);
    expect(blob.userId).toBe(5);
    expect(blob.entries.map((e) => e.id)).toEqual([1]);
    expect(blob.entries[0].t).toEqual(['Recommended']);
  });

  it('uses `now` for an id with no recorded timestamp', () => {
    const blob = buildBlob(5, new Set([9]), { 9: new Set() } as never, new Map(), now, TTL, 100);
    expect(blob.entries[0]).toEqual({ id: 9, t: [], at: now });
  });

  it('caps to the N most-recent ids, evicting the oldest', () => {
    const queried = new Set<number>();
    const membership: Record<number, ReadonlySet<string>> = {};
    const fetchedAt = new Map<number, number>();
    for (let i = 1; i <= 10; i++) {
      queried.add(i);
      membership[i] = new Set();
      fetchedAt.set(i, now - (10 - i)); // id 10 newest, id 1 oldest
    }
    const blob = buildBlob(5, queried, membership as never, fetchedAt, now, TTL, 3);
    expect(blob.entries).toHaveLength(3);
    // newest three, most-recent first
    expect(blob.entries.map((e) => e.id)).toEqual([10, 9, 8]);
  });
});

// ---------------------------------------------------------------------------
// Integration: rehydration folds fresh ids into the store
// ---------------------------------------------------------------------------
describe('rehydration', () => {
  it('reads a fresh persisted blob on init → store is warm (membership + queried)', () => {
    const now = Date.now();
    writeBlob({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 1,
      entries: [
        { id: 10, t: ['Recommended', 'Notify'], at: now },
        { id: 11, t: [], at: now }, // known-not-engaged
      ],
    });

    initEngagedModelsPersistence(1);

    const s = store.getState();
    expect(s.queried.has(10)).toBe(true);
    expect(s.queried.has(11)).toBe(true);
    expect([...(s.membership[10] ?? [])].sort()).toEqual(['Notify', 'Recommended']);
    expect(s.membership[11]?.size ?? 0).toBe(0);
  });

  it('does NOT re-query rehydrated-fresh ids, but DOES query unknown ids', async () => {
    const now = Date.now();
    writeBlob({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 1,
      entries: [{ id: 10, t: ['Recommended'], at: now }],
    });
    initEngagedModelsPersistence(1);

    // Drive the real batcher with a synchronous scheduler.
    __resetEngagedMembershipBatcher();
    let scheduledFlush: (() => void) | null = null;
    engagedMembershipBatcher.schedule = (cb) => {
      scheduledFlush = cb;
    };
    engagedMembershipBatcher.fetch = (ids) => queryMock({ modelIds: ids });

    requestEngagedMembership([10, 11, 12]); // 10 is known-fresh; 11,12 unknown
    scheduledFlush?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].modelIds.sort((a, b) => a - b)).toEqual([11, 12]);
  });
});

// ---------------------------------------------------------------------------
// Per-user isolation
// ---------------------------------------------------------------------------
describe('per-user isolation', () => {
  it("user A's blob is NOT applied when user B initializes (and the foreign blob is cleared)", () => {
    const now = Date.now();
    writeBlob({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 1,
      entries: [{ id: 10, t: ['Recommended'], at: now }],
    });

    initEngagedModelsPersistence(2); // a DIFFERENT user

    expect(store.getState().queried.size).toBe(0); // nothing from user 1 applied
    expect(window.localStorage.getItem(ENGAGED_PERSIST_STORAGE_KEY)).toBeNull(); // foreign blob cleared
  });

  it('a user change resets the in-memory store and clears the previous blob', () => {
    const now = Date.now();
    writeBlob({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 1,
      entries: [{ id: 10, t: ['Recommended'], at: now }],
    });
    initEngagedModelsPersistence(1);
    expect(store.getState().queried.has(10)).toBe(true);

    // User 1 → User 3 (e.g. account switch in the same SPA session).
    initEngagedModelsPersistence(3);
    expect(store.getState().queried.size).toBe(0); // user 1 state gone
    expect(window.localStorage.getItem(ENGAGED_PERSIST_STORAGE_KEY)).toBeNull();
  });

  it('logout (null) resets the store and clears the blob', () => {
    initEngagedModelsPersistence(1);
    store.getState().setMembership(10, 'Recommended', true);
    flushEngagedModelsPersistence();
    expect(readBlob()).not.toBeNull();

    initEngagedModelsPersistence(null);
    expect(store.getState().queried.size).toBe(0);
    expect(window.localStorage.getItem(ENGAGED_PERSIST_STORAGE_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TTL expiry through the full init path
// ---------------------------------------------------------------------------
describe('TTL expiry', () => {
  it('a stale id is dropped (re-queried); a fresh id is kept (skipped)', async () => {
    const now = Date.now();
    writeBlob({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 1,
      entries: [
        { id: 20, t: ['Recommended'], at: now - TTL - 1000 }, // stale
        { id: 21, t: ['Notify'], at: now }, // fresh
      ],
    });

    initEngagedModelsPersistence(1);
    expect(store.getState().queried.has(20)).toBe(false); // stale → unknown
    expect(store.getState().queried.has(21)).toBe(true); // fresh → known

    __resetEngagedMembershipBatcher();
    let scheduledFlush: (() => void) | null = null;
    engagedMembershipBatcher.schedule = (cb) => {
      scheduledFlush = cb;
    };
    engagedMembershipBatcher.fetch = (ids) => queryMock({ modelIds: ids });

    requestEngagedMembership([20, 21]);
    scheduledFlush?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0].modelIds).toEqual([20]); // only the stale one
  });
});

// ---------------------------------------------------------------------------
// Optimistic writes flow through to the persisted blob
// ---------------------------------------------------------------------------
describe('optimistic write-through', () => {
  it('a favorite (Recommended+Notify) is reflected in the store AND persisted on flush', () => {
    initEngagedModelsPersistence(1);
    applyFavoriteToggled(30, true);

    // reflected in the live store
    expect(store.getState().membership[30]?.has('Recommended')).toBe(true);
    expect(store.getState().membership[30]?.has('Notify')).toBe(true);

    flushEngagedModelsPersistence();
    const blob = readBlob()!;
    const entry = blob.entries.find((e) => e.id === 30)!;
    expect(entry.t.sort()).toEqual(['Notify', 'Recommended']);
  });

  it('a notify toggle write-through survives a reload (rehydrate after flush)', () => {
    initEngagedModelsPersistence(1);
    applyNotifyToggled(31, true);
    flushEngagedModelsPersistence();

    // simulate a fresh page load: reset in-memory state + persistence, re-init.
    __resetEngagedModelsPersistenceForTests();
    store.getState().reset();
    initEngagedModelsPersistence(1);

    expect(store.getState().membership[31]?.has('Notify')).toBe(true);
    expect(store.getState().queried.has(31)).toBe(true);
  });

  it('an optimistic write after rehydration re-stamps the id fresh (persisted with a new timestamp)', () => {
    const old = Date.now() - 60_000;
    writeBlob({
      v: ENGAGED_PERSIST_SCHEMA_VERSION,
      userId: 1,
      entries: [{ id: 40, t: [], at: old }],
    });
    initEngagedModelsPersistence(1);
    applyFavoriteToggled(40, true); // user acts on it now
    flushEngagedModelsPersistence();

    const entry = readBlob()!.entries.find((e) => e.id === 40)!;
    expect(entry.t.sort()).toEqual(['Notify', 'Recommended']);
    // NOTE: the acting tab always writes through, so its own state is never stale.
    expect(entry.at).toBeGreaterThanOrEqual(old);
  });
});

// ---------------------------------------------------------------------------
// SSR / storage-unavailable safety — never throw, fall back to memory-only
// ---------------------------------------------------------------------------
describe('storage safety', () => {
  it('no localStorage (SSR-like) → init is a no-op, no throw, store stays memory-only', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    // getStorage() returns null when window.localStorage is absent — the same
    // branch SSR (`typeof window === 'undefined'`) takes.
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => undefined });
    try {
      expect(() => initEngagedModelsPersistence(1)).not.toThrow();
      expect(store.getState().queried.size).toBe(0);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('localStorage that THROWS (private-mode/quota) is caught → no throw, no rehydrate', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => throwing });
    try {
      expect(() => initEngagedModelsPersistence(1)).not.toThrow();
      // an optimistic write + flush must also not throw when setItem throws
      store.getState().setMembership(50, 'Recommended', true);
      expect(() => flushEngagedModelsPersistence()).not.toThrow();
      expect(store.getState().membership[50]?.has('Recommended')).toBe(true); // memory-only still works
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('a corrupt stored blob is ignored (no throw, store empty)', () => {
    window.localStorage.setItem(ENGAGED_PERSIST_STORAGE_KEY, 'corrupt-not-json{{{');
    expect(() => initEngagedModelsPersistence(1)).not.toThrow();
    expect(store.getState().queried.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency + config
// ---------------------------------------------------------------------------
describe('init idempotency', () => {
  it('re-initializing with the same user is a no-op (does not reset the store)', () => {
    initEngagedModelsPersistence(1);
    store.getState().setMembership(60, 'Recommended', true);
    initEngagedModelsPersistence(1); // same user again
    expect(store.getState().membership[60]?.has('Recommended')).toBe(true); // NOT reset
  });

  it('honors an overridden cap via the test config seam', () => {
    const restore = __setEngagedPersistConfigForTests({ maxIds: 2 });
    try {
      initEngagedModelsPersistence(1);
      store.getState().applyServerResult({}, [1, 2, 3, 4]); // 4 known ids
      flushEngagedModelsPersistence();
      expect(readBlob()!.entries).toHaveLength(2); // capped
    } finally {
      restore();
    }
  });
});
