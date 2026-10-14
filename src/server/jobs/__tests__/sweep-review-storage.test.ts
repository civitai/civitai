import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { DocStore, DocStoreMaintenance } from '~/server/services/apps/doc-store';
import {
  createDocStore,
  createDocStoreMaintenance,
  reviewNamespace,
} from '~/server/services/apps/doc-store';
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

const live = vi.hoisted(() => ({ store: undefined as unknown }));
// The job wrapper resolves the process maintenance object; point it at this file's.
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => live.store,
}));
// createJob wraps the handler in lock/metric machinery; hand back what the test asserts on.
vi.mock('../job', () => ({
  createJob: (name: string, cron: string, fn: (ctx: unknown) => unknown) => ({ name, cron, fn }),
}));

const { sweepReviewStorage, sweepReviewStorageJob } = await import(
  '~/server/jobs/sweep-review-storage'
);

/**
 * The review-storage sweep against the REAL store (embedded Postgres, the real migration, the
 * least-privilege role, row-level security on) and an in-memory publish-request status table
 * behind the PRIMARY client only — the replica client answers "no rows", so a sweep that read
 * the replica would take a pending request for a deleted one and purge it.
 */

const MODS = [6_101, 6_202];
let h: Harness;
let store: DocStore;
let maint: DocStoreMaintenance;
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
  maint = createDocStoreMaintenance({ db: h.db });
  live.store = maint;
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  // Purge everything a previous test left, so each test lists only its own requests.
  for (const id of await maint.listReviewAppIds({ limit: 1000 })) await maint.purgeReview(id);
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

    expect(await sweepReviewStorage({ store: maint })).toEqual({
      scanned: 5,
      kept: 1,
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
    await sweepReviewStorage({ store: maint });
    const before = await rows(pending);
    expect(await sweepReviewStorage({ store: maint })).toEqual({
      scanned: 1,
      kept: 1,
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
    // The loop is bounded by the data alone: a cursor that stopped advancing would re-list the
    // first pending request forever. Fail loudly after far more steps than this data needs.
    let steps = 0;
    const jobContext = {
      checkIfCanceled: () => {
        steps += 1;
        if (steps > 50) throw new Error('sweep did not terminate');
      },
    };
    const first = await sweepReviewStorage({ store: maint, batch: 2, page: 1, jobContext });
    expect(first).toMatchObject({ purged: 2, kept: 2 });
    expect(await rows(decided[2])).toBeGreaterThan(0);
    const second = await sweepReviewStorage({ store: maint, batch: 2, page: 1, jobContext });
    expect(second).toMatchObject({ purged: 1, kept: 2 });
    expect(await rows(decided[2])).toBe(0);
  });

  it('a failed purge is counted, the run continues, and the next run finishes it', async () => {
    const stuck = await request('rejected');
    const fine = await request('rejected');
    const flaky: DocStoreMaintenance = {
      ...maint,
      purgeReview: async (id: string) => {
        if (id === stuck) throw new Error('lock timeout');
        return maint.purgeReview(id);
      },
    };
    const counter = async (outcome: string) => {
      const prom = await import('prom-client');
      const m = prom.register.getSingleMetric('civitai_app_block_review_storage_sweep_total');
      return (
        (m ? (await m.get()).values : []).find((v) => v.labels.outcome === outcome)?.value ?? 0
      );
    };
    const before = { purged: await counter('purged'), failed: await counter('failed') };
    expect(await sweepReviewStorage({ store: flaky })).toMatchObject({ purged: 1, failed: 1 });
    expect({ purged: await counter('purged'), failed: await counter('failed') }).toEqual({
      purged: before.purged + 1,
      failed: before.failed + 1,
    });
    expect(await rows(fine)).toBe(0);
    expect(await rows(stuck)).toBeGreaterThan(0);
    expect(await sweepReviewStorage({ store: maint })).toMatchObject({ purged: 1, failed: 0 });
    expect(await rows(stuck)).toBe(0);
  });

  it('purges only final statuses: a status it does not know is kept', async () => {
    const unknown = await request('changes_requested');
    const before = await rows(unknown);
    expect(await sweepReviewStorage({ store: maint })).toMatchObject({ kept: 1, purged: 0 });
    expect(await rows(unknown)).toBe(before);
  });

  it('a store with no connection stops the run (storage_disabled), it does not count a failure per request', async () => {
    await expect(
      sweepReviewStorage({ store: createDocStoreMaintenance({ db: null }) })
    ).rejects.toMatchObject({
      code: 'storage_disabled',
    });
  });

  it('every statement the sweep sent passed the recorder', () => {
    expect(h.statements.some((s) => /FROM appdata\.usage_app u WHERE u\.ns LIKE/.test(s.sql))).toBe(
      true
    );
    expect(h.violations).toEqual([]);
  });
});

describe('sweepReviewStorageJob', () => {
  const job = sweepReviewStorageJob as unknown as {
    name: string;
    cron: string;
    fn: (ctx: unknown) => Promise<Record<string, unknown>>;
  };

  it('is the hourly sweep-review-storage job, registered with the job runner', () => {
    expect({ name: job.name, cron: job.cron }).toEqual({
      name: 'sweep-review-storage',
      cron: '35 * * * *',
    });
    const route = readFileSync(
      path.resolve(__dirname, '../../../pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    expect(route).toMatch(
      /^import \{ sweepReviewStorageJob \} from '~\/server\/jobs\/sweep-review-storage';$/m
    );
    // Inside the jobs array, not merely imported.
    expect(route).toMatch(/^  sweepReviewStorageJob,$/m);
  });

  it('runs the sweep against the process store and returns its result', async () => {
    await request('rejected');
    const result = await job.fn({ checkIfCanceled: () => undefined });
    expect(result).toMatchObject({ purged: 1, failed: 0 });
  });

  it('FAIL-OPEN: no store connection returns { disabled }, any other error returns { error }', async () => {
    live.store = createDocStoreMaintenance({ db: null });
    try {
      expect(await job.fn({ checkIfCanceled: () => undefined })).toEqual({ disabled: true });
      live.store = {
        listReviewAppIds: async () => {
          throw new Error('appdata down');
        },
      };
      expect(await job.fn({ checkIfCanceled: () => undefined })).toEqual({ error: true });
    } finally {
      live.store = maint;
    }
  });
});
