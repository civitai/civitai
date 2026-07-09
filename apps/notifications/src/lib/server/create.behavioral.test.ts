import { beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioral coverage for the producer write path (closes G2 from the 2026-07-03 coverage audit —
// create.ts was 0%). No suite touched createNotification before this; the module was entirely unrun.
//
// Same "fake pool records SQL + params" idiom as operations.test.ts / poll-loop.behavioral.test.ts, but
// driven to exercise the actual CONTROL FLOW rather than only inspect the emitted string:
//   - recipient dedup (userId + userIds → Set)
//   - the opt-out filter + the `-1` sentinel drop (the branch that, if inverted, delivers to users who
//     disabled the type — a privacy/spam regression)
//   - UPDATE-first → INSERT-ON-CONFLICT fallback (existing key vs new key)
//   - the error swallow: a param/cast throw must be COUNTED (logged to Axiom + {queued:0}), never a false
//     {queued:0} 202 that silently reports success while queuing nothing.
//
// createNotification is the only entry point and every branch is reachable through it, so NO source
// export-widening was needed — create.ts is byte-identical to origin/main.

// ---- Shared, hoisted mock state (vi.mock factories hoist above imports; see operations.test.ts) ---------
const h = vi.hoisted(() => {
  const state = {
    // Recorded queries, split by pool so we can assert "no write happened".
    mainCalls: [] as Array<{ sql: string; params?: unknown[] }>,
    notifCalls: [] as Array<{ sql: string; params?: unknown[] }>,
    // Canned responses.
    disabledRows: [] as Array<{ userId: number }>, // UserNotificationSettings opt-out rows
    updateRows: [] as Array<{ id: number }>, // rows the UPDATE ... RETURNING id yields
    insertRows: [] as unknown[],
    // Fault injection: throw at a specific step to exercise the catch/swallow contract.
    throwOn: null as null | 'settings' | 'update' | 'insert',
  };
  const reset = () => {
    state.mainCalls = [];
    state.notifCalls = [];
    state.disabledRows = [];
    state.updateRows = [];
    state.insertRows = [];
    state.throwOn = null;
  };
  return { state, reset };
});

vi.mock('./clients/db', () => ({
  // Primary-DB read pool → the userNotificationSettings opt-out filter.
  mainDbRead: () => ({
    cancellableQuery: async (sql: string, params?: unknown[]) => {
      h.state.mainCalls.push({ sql, params });
      if (h.state.throwOn === 'settings') throw new Error('settings boom');
      return { result: async () => h.state.disabledRows };
    },
  }),
  // Notif WRITE pool → the UPDATE-first / INSERT-ON-CONFLICT upsert. Dispatch on SQL shape so a single
  // fake serves both statements and we can inject a throw on either.
  notifDbWrite: () => ({
    cancellableQuery: async (sql: string, params?: unknown[]) => {
      h.state.notifCalls.push({ sql, params });
      if (sql.includes('UPDATE "PendingNotification"')) {
        if (h.state.throwOn === 'update') throw new Error('update boom');
        return { result: async () => h.state.updateRows };
      }
      // INSERT ... ON CONFLICT fallback
      if (h.state.throwOn === 'insert') throw new Error('insert boom');
      return { result: async () => h.state.insertRows };
    },
  }),
}));

// logToAxiom must return a thenable (create.ts calls `.catch(...)` on it). vi.fn(async ...) does.
vi.mock('./clients/axiom', () => ({ logToAxiom: vi.fn(async () => {}) }));

import type { CreateNotificationPendingRow } from '@civitai/notifications';
import { createNotification } from './create';
import { logToAxiom } from './clients/axiom';

// A minimal valid producer payload; individual tests override recipients / debounce.
function payload(over: Partial<CreateNotificationPendingRow> = {}): CreateNotificationPendingRow {
  return {
    key: 'comment:1',
    type: 'comment',
    category: 'Comment',
    details: { foo: 'bar' },
    ...over,
  };
}

const settingsCall = () => h.state.mainCalls.find((c) => c.sql.includes('UserNotificationSettings'));
const updateCall = () => h.state.notifCalls.find((c) => c.sql.includes('UPDATE "PendingNotification"'));
const insertCall = () => h.state.notifCalls.find((c) => c.sql.includes('INSERT INTO "PendingNotification"'));

beforeEach(() => {
  h.reset();
  vi.clearAllMocks();
});

// =========================================================================================================
describe('recipient resolution', () => {
  it('merges userId into userIds and DEDUPES to a single recipient set', async () => {
    h.state.updateRows = [{ id: 1 }]; // existing key → no INSERT
    const ret = await createNotification(payload({ userIds: [11, 22], userId: 22 }));

    // 22 appears in both userIds and userId → deduped to one.
    expect(settingsCall()!.params).toEqual([[11, 22], 'comment']);
    expect(ret).toEqual({ queued: 2 });
  });

  it('returns {queued:0} and touches NEITHER pool when there are no recipients', async () => {
    const ret = await createNotification(payload({ userIds: [], userId: undefined }));

    expect(ret).toEqual({ queued: 0 });
    // Early return before the try block: no opt-out query, no write.
    expect(h.state.mainCalls).toHaveLength(0);
    expect(h.state.notifCalls).toHaveLength(0);
  });
});

// =========================================================================================================
describe('opt-out filter + `-1` sentinel drop', () => {
  it('EXCLUDES users who disabled this type from the queued recipient set', async () => {
    h.state.disabledRows = [{ userId: 22 }]; // 22 opted out
    h.state.updateRows = [{ id: 5 }];
    const ret = await createNotification(payload({ userIds: [11, 22, 33] }));

    // 22 must NOT reach the write. If the filter is inverted, targets become [22] and this fails.
    expect(updateCall()!.params![0]).toEqual([11, 33]);
    expect(updateCall()!.params![0]).not.toContain(22);
    expect(ret).toEqual({ queued: 2 });
  });

  it('DROPS the -1 sentinel (never a real user) from the recipient set', async () => {
    h.state.updateRows = [{ id: 5 }];
    const ret = await createNotification(payload({ userIds: [-1, 11] }));

    expect(updateCall()!.params![0]).toEqual([11]);
    expect(updateCall()!.params![0]).not.toContain(-1);
    expect(ret).toEqual({ queued: 1 });
  });

  it('does NOT write/queue anything when EVERY recipient is filtered out (all opted out)', async () => {
    h.state.disabledRows = [{ userId: 11 }, { userId: 22 }];
    const ret = await createNotification(payload({ userIds: [11, 22] }));

    expect(ret).toEqual({ queued: 0 });
    // The opt-out query ran, but NO UPDATE/INSERT was issued for a fully-filtered set.
    expect(settingsCall()).toBeDefined();
    expect(h.state.notifCalls).toHaveLength(0);
  });

  it('does NOT write/queue anything when the only recipient is the -1 sentinel', async () => {
    const ret = await createNotification(payload({ userIds: [-1] }));

    expect(ret).toEqual({ queued: 0 });
    expect(h.state.notifCalls).toHaveLength(0);
  });
});

// =========================================================================================================
describe('UPDATE-first → INSERT-ON-CONFLICT fallback', () => {
  it('UPDATE hits an existing key → does NOT INSERT (avoids burning a sequence id)', async () => {
    h.state.updateRows = [{ id: 42 }]; // key exists
    const ret = await createNotification(payload({ userIds: [11] }));

    expect(updateCall()).toBeDefined();
    expect(insertCall()).toBeUndefined();
    expect(h.state.notifCalls).toHaveLength(1);
    expect(ret).toEqual({ queued: 1 });
  });

  it('UPDATE affects 0 rows (new key) → falls back to INSERT ... ON CONFLICT (key) DO UPDATE', async () => {
    h.state.updateRows = []; // key does not exist yet
    const ret = await createNotification(payload({ userIds: [11, 22], debounceSeconds: 300 }));

    const ins = insertCall();
    expect(ins).toBeDefined();
    expect(h.state.notifCalls).toHaveLength(2); // UPDATE then INSERT
    // ON CONFLICT clause keyed on `key` — the cross-writer race guard.
    expect(ins!.sql).toContain('ON CONFLICT (key)');
    expect(ins!.sql).toContain('DO UPDATE SET');
    expect(ret).toEqual({ queued: 2 });
  });

  it('INSERT positional params + casts are indexed $1..$6 in the documented order', async () => {
    h.state.updateRows = [];
    await createNotification(payload({ userIds: [11, 22], debounceSeconds: 300 }));

    const ins = insertCall()!;
    // $1 key, $2 type, $3 category, $4 users, $5 details(json), $6 debounceSeconds
    expect(ins.params).toEqual([
      'comment:1',
      'comment',
      'Comment',
      [11, 22],
      JSON.stringify({ foo: 'bar' }),
      300,
    ]);
    // Casts must line up with the placeholders (the real off-by-one / cast-shape risk).
    expect(ins.sql).toContain('$3::"NotificationCategory"');
    expect(ins.sql).toContain('$4::int[]');
    expect(ins.sql).toContain('$5::jsonb');
  });

  it('defaults debounceSeconds ($6) to null when the producer omits it', async () => {
    h.state.updateRows = [];
    await createNotification(payload({ userIds: [11] })); // no debounceSeconds

    expect(insertCall()!.params![5]).toBeNull();
  });

  it('UPDATE ... RETURNING id is keyed on `key` with the filtered targets as $1::int[]', async () => {
    h.state.updateRows = [{ id: 1 }];
    await createNotification(payload({ userIds: [11] }));

    const upd = updateCall()!;
    expect(upd.sql).toContain('$1::int[]');
    expect(upd.sql).toContain('WHERE "key" = $2');
    expect(upd.params).toEqual([[11], 'comment:1']);
  });
});

// =========================================================================================================
describe('error swallow contract (must be COUNTED, not a false success)', () => {
  it('opt-out query throws → logs to Axiom and returns {queued:0} (no throw, no false success)', async () => {
    h.state.throwOn = 'settings';
    const ret = await createNotification(payload({ userIds: [11] }));

    expect(ret).toEqual({ queued: 0 });
    // The failure MUST surface via the Axiom warning — a bare {queued:0} with no log would be a silent
    // false-success 202. Assert the surfacing happened, with the row key for correlation.
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    const logged = vi.mocked(logToAxiom).mock.calls[0][0];
    expect(logged).toMatchObject({ type: 'warning', name: 'Failed to create notification' });
    expect((logged as any).details).toEqual({ key: 'comment:1' });
    // Never reached the write pool.
    expect(h.state.notifCalls).toHaveLength(0);
  });

  it('UPDATE throws (e.g. a param/cast error) → surfaces to Axiom, returns {queued:0}', async () => {
    h.state.throwOn = 'update';
    const ret = await createNotification(payload({ userIds: [11] }));

    expect(ret).toEqual({ queued: 0 });
    expect(logToAxiom).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logToAxiom).mock.calls[0][0]).toMatchObject({
      name: 'Failed to create notification',
    });
  });

  it('INSERT throws → surfaces to Axiom, returns {queued:0}', async () => {
    h.state.updateRows = []; // force the INSERT branch
    h.state.throwOn = 'insert';
    const ret = await createNotification(payload({ userIds: [11] }));

    expect(ret).toEqual({ queued: 0 });
    expect(logToAxiom).toHaveBeenCalledTimes(1);
  });

  it('a successful create does NOT log an error', async () => {
    h.state.updateRows = [{ id: 1 }];
    await createNotification(payload({ userIds: [11] }));
    expect(logToAxiom).not.toHaveBeenCalled();
  });
});
