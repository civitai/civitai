import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { sweepReviewStorage } from '~/server/jobs/sweep-review-storage';
import type { DocStore } from '~/server/services/apps/doc-store';
import { createDocStore, reviewNamespace } from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  ctx,
  NS_DEV,
  NS_PROD,
  POSTS,
  PREFS,
  TALLIES,
} from '~/server/services/apps/__tests__/doc-store.functional';
import { APPDATA_TABLES } from '~/server/services/apps/__tests__/doc-store.sql-scan';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The review-storage sweep against the REAL store (embedded Postgres, the real migration, the
 * least-privilege role, row-level security on) and an in-memory publish-request status table
 * behind the PRIMARY client only — the replica client answers "no rows", so a sweep that read
 * the replica would take a pending request for a deleted one and purge it.
 */

const MODS = [6_101, 6_202];
let h: Harness;
let store: DocStore;
const statuses = new Map<string, string>();
let seq = 0;

/** A request id, its status in the main DB (`null`: the row no longer exists), and review data. */
async function request(status: string | null): Promise<string> {
  seq += 1;
  const id = `pubreq_SWEEP${String(seq).padStart(3, '0')}`;
  if (status !== null) statuses.set(id, status);
  for (const uid of MODS) {
    const c = ctx(id, reviewNamespace(id, uid), uid);
    await store.put(c, PREFS, 'k', { uid });
    await store.put(c, POSTS, 'p', { status: 'open' });
    await store.mark(c, POSTS, 'p', 'vote');
    await store.increment(c, TALLIES, 'g', 'plays', 1);
  }
  return id;
}

async function rows(appId: string, nsLike = 'rev:%'): Promise<number> {
  let n = 0;
  for (const t of APPDATA_TABLES) {
    const [r] = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1 AND ns LIKE $2`,
      [appId, nsLike]
    );
    n += Number(r.n);
  }
  return n;
}

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  store = createDocStore({ db: h.db });
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  // Purge everything a previous test left, so each test lists only its own requests.
  for (const id of await store.listReviewAppIds({ limit: 1000 })) await store.purgeReview(id);
  statuses.clear();
  dbMock.dbWrite.appBlockPublishRequest.findMany.mockImplementation(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => statuses.has(id)).map((id) => ({ id, status: statuses.get(id) }))
  );
});

describe('sweepReviewStorage', () => {
  it('purges every request that is not pending (decided, superseded, or gone), never a pending one', async () => {
    const pending = await request('pending');
    const purge = [
      await request('approved'),
      await request('rejected'),
      await request('withdrawn'),
      await request(null),
    ];
    // prod and dev rows under the pending request's id, and an approved app's: never touched.
    await store.put(ctx(pending, NS_PROD, MODS[0]), PREFS, 'k', { a: 1 });
    await store.put(ctx(purge[0], NS_DEV, MODS[0]), PREFS, 'k', { a: 1 });
    const pendingRows = await rows(pending);
    expect(pendingRows).toBeGreaterThan(0);
    for (const id of purge) expect(await rows(id)).toBe(pendingRows);

    expect(await sweepReviewStorage({ store })).toEqual({
      scanned: 5,
      pending: 1,
      purged: 4,
      failed: 0,
    });

    expect(await rows(pending)).toBe(pendingRows);
    for (const id of purge) expect({ id, rows: await rows(id) }).toEqual({ id, rows: 0 });
    expect(await rows(pending, 'prod')).toBeGreaterThan(0);
    expect(await rows(purge[0], 'dev:%')).toBeGreaterThan(0);
    // The replica was never consulted.
    expect(dbMock.dbRead.appBlockPublishRequest.findMany).not.toHaveBeenCalled();
  });

  it('is idempotent: a second run purges nothing and still leaves the pending request alone', async () => {
    const pending = await request('pending');
    await request('rejected');
    await sweepReviewStorage({ store });
    const before = await rows(pending);
    expect(await sweepReviewStorage({ store })).toEqual({
      scanned: 1,
      pending: 1,
      purged: 0,
      failed: 0,
    });
    expect(await rows(pending)).toBe(before);
  });

  it('is bounded per run, and pages past pending requests', async () => {
    await request('pending');
    await request('pending');
    const decided = [
      await request('rejected'),
      await request('rejected'),
      await request('rejected'),
    ];
    const first = await sweepReviewStorage({ store, batch: 2, page: 1 });
    expect(first).toMatchObject({ purged: 2, pending: 2 });
    expect(await rows(decided[2])).toBeGreaterThan(0);
    const second = await sweepReviewStorage({ store, batch: 2, page: 1 });
    expect(second).toMatchObject({ purged: 1, pending: 2 });
    expect(await rows(decided[2])).toBe(0);
  });

  it('a failed purge is counted, the run continues, and the next run finishes it', async () => {
    const stuck = await request('rejected');
    const fine = await request('rejected');
    const flaky: DocStore = {
      ...store,
      purgeReview: async (id: string) => {
        if (id === stuck) throw new Error('lock timeout');
        return store.purgeReview(id);
      },
    };
    expect(await sweepReviewStorage({ store: flaky })).toMatchObject({ purged: 1, failed: 1 });
    expect(await rows(fine)).toBe(0);
    expect(await rows(stuck)).toBeGreaterThan(0);
    expect(await sweepReviewStorage({ store })).toMatchObject({ purged: 1, failed: 0 });
    expect(await rows(stuck)).toBe(0);
  });

  it('a store with no connection stops the run (storage_disabled), it does not count a failure per request', async () => {
    await expect(sweepReviewStorage({ store: createDocStore({ db: null }) })).rejects.toMatchObject(
      {
        code: 'storage_disabled',
      }
    );
  });

  it('every statement the sweep sent passed the recorder', () => {
    expect(h.statements.some((s) => /SELECT u\.app_id FROM appdata\.usage_app u/.test(s.sql))).toBe(
      true
    );
    expect(h.violations).toEqual([]);
  });
});
