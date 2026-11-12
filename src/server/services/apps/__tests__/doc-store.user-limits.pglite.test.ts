import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStore,
  createDocStoreMaintenance,
  type DocStoreDb,
} from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import {
  BOARD,
  ctx,
  TALLIES,
  expectCode,
  freshApp,
  NS_PROD,
  PREFS,
  VIEWER_1,
  VIEWER_2,
} from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The per-user ceiling comes from `DocStoreDeps.userLimits` — production wires each user's
 * membership-tier caps (`docStoreUserLimits`) — in place of the store-wide `limits.userDocs` /
 * `limits.userBytes`. Two users with different ceilings in one app, against the real migration.
 * The store-wide per-user figures here are deliberately loose, so a write that read them instead
 * of the user's own ceiling would succeed where these cases expect a refusal.
 */

const LOOSE = { appBytes: 1_000_000, appDocs: 10_000, userBytes: 1_000_000, userDocs: 10_000 };
const CEILINGS: Record<number, { userBytes: number; userDocs: number }> = {
  [VIEWER_1]: { userBytes: 1_000_000, userDocs: 2 },
  [VIEWER_2]: { userBytes: 1_000_000, userDocs: 3 },
};

let h: Harness;
beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
});
afterAll(async () => {
  await h?.close();
});

function storeWithCeilings() {
  const userLimits = vi.fn(async (uid: number) => CEILINGS[uid]);
  return { store: createDocStore({ db: h.db, limits: LOOSE, userLimits }), userLimits };
}

describe('per-user ceilings from userLimits', () => {
  it('each user is held to their own ceiling, not the store-wide one', async () => {
    const app = freshApp('tierdocs');
    const { store } = storeWithCeilings();
    const one = ctx(app, NS_PROD, VIEWER_1);
    const two = ctx(app, NS_PROD, VIEWER_2);
    await store.put(one, PREFS, 'a', { v: 1 });
    await store.put(one, PREFS, 'b', { v: 1 });
    const err = await expectCode(store.put(one, PREFS, 'c', { v: 1 }), 'quota_exceeded');
    expect(err.details).toEqual({ ceiling: 'viewer' });
    // The other user, with a higher ceiling, gets a third document in the same app.
    for (const k of ['a', 'b', 'c']) await store.put(two, PREFS, k, { v: 1 });
    await expectCode(store.put(two, PREFS, 'd', { v: 1 }), 'quota_exceeded');
  });

  it("a shared document is held to its author's ceiling", async () => {
    const app = freshApp('tiershared');
    const { store, userLimits } = storeWithCeilings();
    const one = ctx(app, NS_PROD, VIEWER_1);
    await store.put(one, BOARD, 'p1', { p: 'x' });
    await store.put(one, BOARD, 'p2', { p: 'x' });
    const err = await expectCode(store.put(one, BOARD, 'p3', { p: 'x' }), 'quota_exceeded');
    expect(err.details).toEqual({ ceiling: 'author' });
    expect(userLimits.mock.calls.every(([uid]) => uid === VIEWER_1)).toBe(true);
  });

  // The figure the storage `info` route and the running app's notice show is this same function.
  it('viewerLimits is the ceiling the writes above were held to, per user', async () => {
    const { store } = storeWithCeilings();
    expect(await store.viewerLimits(VIEWER_1)).toEqual({ userBytes: 1_000_000, userDocs: 2 });
    expect(await store.viewerLimits(VIEWER_2)).toEqual({ userBytes: 1_000_000, userDocs: 3 });
    const plain = createDocStore({ db: h.db, limits: LOOSE });
    expect(await plain.viewerLimits(VIEWER_1)).toEqual({ userBytes: 1_000_000, userDocs: 10_000 });
  });

  // The ceiling is resolved BEFORE the transaction opens, never while the write holds the app's
  // usage-row lock (`SQL_CHARGE_APP`, which runs right after `beforeUsageCharge`).
  it.each([
    ['a put', 'put'],
    ['an increment', 'increment'],
  ])("%s resolves the viewer's ceiling before the transaction and the lock", async (_l, op) => {
    const app = freshApp('tierorder');
    const events: string[] = [];
    const db: DocStoreDb = {
      connect: async () => {
        events.push('connect');
        return h.db.connect();
      },
    };
    const store = createDocStore({
      db,
      limits: LOOSE,
      userLimits: async (uid) => {
        events.push('ceiling');
        return CEILINGS[uid];
      },
      hooks: {
        beforeUsageCharge: async () => {
          events.push('charge');
        },
      },
    });
    const one = ctx(app, NS_PROD, VIEWER_1);
    if (op === 'put') await store.put(one, PREFS, 'a', { v: 1 });
    else await store.increment(one, TALLIES, 'c', 'plays');
    expect(events.filter((e) => e !== 'connect').slice(0, 2)).toEqual(['ceiling', 'charge']);
    expect(events.indexOf('ceiling')).toBeLessThan(events.indexOf('connect'));
    // Resolved once, outside; the charge to the same viewer did not resolve it again inside.
    expect(events.filter((e) => e === 'ceiling')).toEqual(['ceiling']);
  });

  // A migration charges its documents' owners. Every owner's ceiling on the page is resolved
  // once, before the first document's transaction, never under the usage-row lock.
  it("a migration resolves every owner's ceiling before any document's transaction", async () => {
    const app = freshApp('tiermigrate');
    const { store } = storeWithCeilings();
    await store.put(ctx(app, NS_PROD, VIEWER_1), PREFS, 'a', { v: 1 });
    await store.put(ctx(app, NS_PROD, VIEWER_2), PREFS, 'a', { v: 1 });
    await store.put(ctx(app, NS_PROD, VIEWER_2), PREFS, 'b', { v: 1 });
    const events: string[] = [];
    const maintenance = createDocStoreMaintenance({
      db: h.db,
      limits: LOOSE,
      userLimits: async (uid) => {
        events.push(`ceiling:${uid}`);
        return CEILINGS[uid];
      },
      hooks: {
        beforeUsageCharge: async () => {
          events.push('charge');
        },
      },
    });
    // Grows every document, so each charge adds bytes to its owner.
    const result = await maintenance.migrateDocuments(app, PREFS, (d) => ({ ...d, pad: 'xxxx' }));
    expect(result).toMatchObject({ scanned: 3, migrated: 3, failed: 0 });
    const firstCharge = events.indexOf('charge');
    expect(firstCharge).toBeGreaterThan(0);
    // Two distinct owners, each resolved once, both before the first charge; none after.
    expect(events.slice(0, firstCharge).sort()).toEqual([
      `ceiling:${VIEWER_1}`,
      `ceiling:${VIEWER_2}`,
    ]);
    expect(events.slice(firstCharge).filter((e) => e.startsWith('ceiling'))).toEqual([]);
  });

  // A page holds up to 1,000 documents, so up to 1,000 owners: their ceilings are looked up a
  // bounded number at a time, never all at once.
  it("a migration looks up at most 10 owners' ceilings at a time", async () => {
    const app = freshApp('tierfanout');
    const owners = Array.from({ length: 25 }, (_, i) => 5_000 + i);
    const writer = createDocStore({ db: h.db, limits: LOOSE });
    for (const uid of owners) await writer.put(ctx(app, NS_PROD, uid), PREFS, 'a', { v: 1 });
    let inFlight = 0;
    let peak = 0;
    const maintenance = createDocStoreMaintenance({
      db: h.db,
      limits: LOOSE,
      userLimits: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return { userBytes: 1_000_000, userDocs: 10_000 };
      },
    });
    const result = await maintenance.migrateDocuments(app, PREFS, (d) => ({ ...d, pad: 'x' }));
    expect(result).toMatchObject({ scanned: 25, migrated: 25, failed: 0 });
    expect(peak).toBe(10);
  });

  it('a write that only frees reads no ceiling, and is allowed', async () => {
    const app = freshApp('tierfree');
    const { store, userLimits } = storeWithCeilings();
    const one = ctx(app, NS_PROD, VIEWER_1);
    await store.put(one, PREFS, 'a', { v: 1 });
    userLimits.mockClear();
    await store.delete(one, PREFS, 'a');
    expect(userLimits).not.toHaveBeenCalled();
  });
});
