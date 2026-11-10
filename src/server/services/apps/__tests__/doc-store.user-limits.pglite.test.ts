import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDocStore } from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import {
  BOARD,
  ctx,
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
