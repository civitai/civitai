import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import type { DocStore, DocStoreMaintenance } from '~/server/services/apps/doc-store';
import { createDocStore, createDocStoreMaintenance } from '~/server/services/apps/doc-store';
import {
  createPgliteHarness,
  type Harness,
} from '~/server/services/apps/__tests__/doc-store.harness';
import {
  ctx,
  freshApp,
  NS_PROD,
  POSTS,
  PREFS,
  TALLIES,
} from '~/server/services/apps/__tests__/doc-store.functional';
import { APPDATA_TABLES } from '~/server/services/apps/__tests__/doc-store.sql-scan';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const live = vi.hoisted(() => ({ store: undefined as unknown }));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => live.store,
}));
vi.mock('../job', () => ({
  createJob: (name: string, cron: string, fn: (ctx: unknown) => unknown) => ({ name, cron, fn }),
}));

const { reapDeletedAppStorage, reapDeletedAppStorageJob, STORAGE_REAP_AFTER_DAYS } = await import(
  '~/server/jobs/reap-deleted-app-storage'
);

/**
 * The deleted-app reaper against the REAL store (embedded Postgres, the real migrations, the
 * least-privilege role, RLS on) and a second embedded Postgres standing in for the main
 * database's `app_blocks` table, with the migration's two columns: the job's own SQL runs there
 * unchanged, so its eligibility predicate is the one under test, not a re-implementation of it.
 *
 * Boundaries OVERSHOOT the waiting period on both sides by an hour, never sit on it.
 */

const NOW = new Date('2026-11-02T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const PERIOD = STORAGE_REAP_AFTER_DAYS * DAY;
// Pairwise distinct, and distinct from every id the other suites use.
const USERS = [9_101, 9_202];

let h: Harness;
let store: DocStore;
let maint: DocStoreMaintenance;
let main: PGlite;

/**
 * What a restore through Prisma writes when it forgets `storage_deleted_at`: the status, and
 * `updated_at` (Prisma's `@updatedAt`).
 */
async function restoreTo(id: string, status: string) {
  await main.query(`UPDATE app_blocks SET status = $2, updated_at = $3 WHERE id = $1`, [
    id,
    status,
    NOW,
  ]);
}

/** A Prisma tagged-template call as positional SQL. */
const toSql = (strings: TemplateStringsArray) =>
  strings.reduce((sql, part, i) => sql + (i === 0 ? '' : `$${i}`) + part, '');

async function rowsOf(appId: string, harness: Harness = h): Promise<number> {
  let n = 0;
  for (const t of APPDATA_TABLES) {
    const [r] = await harness.raw(`SELECT count(*)::int AS n FROM appdata.${t} WHERE app_id = $1`, [
      appId,
    ]);
    n += Number(r.n);
  }
  return n;
}

/**
 * An app with data from two users in prod and a developer's dev namespace. The block was last
 * written (`updated_at`) 60 days ago unless given, before every deletion the cases make.
 */
async function app(
  tag: string,
  block: { status: string; deletedAt: Date | null; purgedAt?: Date | null; updatedAt?: Date }
): Promise<string> {
  const id = freshApp(tag);
  for (const uid of USERS) {
    const c = ctx(id, NS_PROD, uid);
    await store.put(c, PREFS, 'p', { uid });
    await store.put(c, POSTS, `post-${uid}`, { status: 'open' });
    await store.increment(c, TALLIES, 'game', 'plays', 1);
  }
  await store.put(ctx(id, `dev:${USERS[0]}`, USERS[0]), PREFS, 'dev', { a: 1 });
  await main.query(
    `INSERT INTO app_blocks (id, status, storage_deleted_at, storage_purged_at, updated_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, block.status, block.deletedAt, block.purgedAt ?? null, block.updatedAt ?? ago(60 * DAY)]
  );
  return id;
}

async function purgedAt(id: string): Promise<Date | null> {
  const [r] = (
    await main.query<{ p: Date | null }>(
      `SELECT storage_purged_at AS p FROM app_blocks WHERE id = $1`,
      [id]
    )
  ).rows;
  return r.p;
}

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  store = createDocStore({ db: h.db });
  maint = createDocStoreMaintenance({ db: h.db });
  live.store = maint;
  main = new PGlite();
  await main.exec(`CREATE TABLE app_blocks (
    id text PRIMARY KEY,
    status text NOT NULL,
    storage_deleted_at timestamptz,
    storage_purged_at timestamptz,
    updated_at timestamptz NOT NULL)`);
});

afterAll(async () => {
  if (h) expect(h.violations).toEqual([]);
  await h?.close();
  await main?.close();
});

beforeEach(async () => {
  await main.exec('DELETE FROM app_blocks');
  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await main.query(toSql(strings), values)).rows
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await main.query(toSql(strings), values)).affectedRows ?? 0
  );
});

describe('reapDeletedAppStorage', () => {
  it('purges an app deleted 30 days + 1h ago, and not one deleted 30 days − 1h ago', async () => {
    const due = await app('DUE', { status: 'suspended', deletedAt: ago(PERIOD + HOUR) });
    const early = await app('EARLY', { status: 'suspended', deletedAt: ago(PERIOD - HOUR) });
    const earlyRows = await rowsOf(early);
    expect(await rowsOf(due)).toBeGreaterThan(10);

    const out = await reapDeletedAppStorage({ store: maint, now: NOW });

    expect(out).toMatchObject({ scanned: 1, purged: 1, failed: 0, stopped: 0, partial: 0 });
    expect(await rowsOf(due)).toBe(0);
    expect(await purgedAt(due)).not.toBeNull();
    expect(await rowsOf(early)).toBe(earlyRows);
    expect(await purgedAt(early)).toBeNull();

    // Two hours later the early one is past the period too.
    const later = await reapDeletedAppStorage({
      store: maint,
      now: new Date(NOW.getTime() + 2 * HOUR),
    });
    expect(later).toMatchObject({ scanned: 1, purged: 1 });
    expect(await rowsOf(early)).toBe(0);
  });

  it('never touches a restored app, a live app, or an app that was never deleted', async () => {
    // Restored: approved again, although the column still carries an old deletion.
    const reApproved = await app('REAPPROVED', { status: 'approved', deletedAt: ago(40 * DAY) });
    // Restored: deletion cleared, still suspended (e.g. back in review).
    const cleared = await app('CLEARED', { status: 'suspended', deletedAt: null });
    const liveApp = await app('LIVE', { status: 'approved', deletedAt: null });
    const before = await Promise.all([reApproved, cleared, liveApp].map((id) => rowsOf(id)));

    const out = await reapDeletedAppStorage({ store: maint, now: NOW });

    expect(out.scanned).toBe(0);
    expect(await Promise.all([reApproved, cleared, liveApp].map((id) => rowsOf(id)))).toEqual(
      before
    );
  });

  it("stops within one batch when the app is restored mid-purge, and doesn't stamp it", async () => {
    const id = await app('MIDRESTORE', { status: 'suspended', deletedAt: ago(PERIOD + DAY) });
    const before = await rowsOf(id);
    let checks = 0;
    const base = dbMock.dbWrite.$queryRaw.getMockImplementation();
    dbMock.dbWrite.$queryRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        // After the first batch's check, a moderator relists the app.
        if (/AS eligible/.test(toSql(strings)) && (checks += 1) === 2) {
          await main.query(`UPDATE app_blocks SET status = 'approved' WHERE id = $1`, [id]);
        }
        return base?.(strings, ...values);
      }
    );

    const out = await reapDeletedAppStorage({ store: maint, now: NOW, batchRows: 1 });

    expect(out).toMatchObject({ scanned: 1, stopped: 1, purged: 0 });
    // One batch of one row ran before the restore was seen; nothing after it.
    expect(out.rows).toBe(1);
    expect(await rowsOf(id)).toBe(before - 1);
    expect(await purgedAt(id)).toBeNull();
  });

  it('is resumable and idempotent: a run that hits its row budget continues next run, then nothing is left to do', async () => {
    const id = await app('BUDGET', { status: 'suspended', deletedAt: ago(PERIOD + DAY) });

    const first = await reapDeletedAppStorage({
      store: maint,
      now: NOW,
      batchRows: 2,
      rowsPerRun: 3,
    });
    expect(first).toMatchObject({ scanned: 1, partial: 1, purged: 0 });
    expect(await rowsOf(id)).toBeGreaterThan(0);
    expect(await purgedAt(id)).toBeNull();

    const second = await reapDeletedAppStorage({ store: maint, now: NOW });
    expect(second).toMatchObject({ scanned: 1, purged: 1 });
    expect(await rowsOf(id)).toBe(0);

    expect(await reapDeletedAppStorage({ store: maint, now: NOW })).toMatchObject({ scanned: 0 });
  });

  it('a deletion newer than the last purge makes the app eligible again', async () => {
    const id = await app('AGAIN', {
      status: 'suspended',
      deletedAt: ago(PERIOD + DAY),
      purgedAt: ago(PERIOD + 2 * DAY),
    });
    expect(await reapDeletedAppStorage({ store: maint, now: NOW })).toMatchObject({ purged: 1 });
    expect(await rowsOf(id)).toBe(0);
  });

  // A restore that returns the block to draft or pending leaves `storage_deleted_at` set unless
  // the restore path clears it; the block was written after its deletion, so it is not deleted.
  for (const status of ['draft', 'pending'] as const) {
    it(`never purges a block restored to ${status} after its deletion, however old the deletion`, async () => {
      const id = await app(`RESTORED${status.toUpperCase()}`, {
        status,
        deletedAt: ago(40 * DAY),
        updatedAt: ago(35 * DAY),
      });
      const before = await rowsOf(id);

      const out = await reapDeletedAppStorage({ store: maint, now: NOW });

      expect(out.scanned).toBe(0);
      expect(await rowsOf(id)).toBe(before);
      expect(await purgedAt(id)).toBeNull();
    });

    it(`stops within one batch when the block is restored to ${status} mid-purge`, async () => {
      const id = await app(`MID${status.toUpperCase()}`, {
        status: 'suspended',
        deletedAt: ago(PERIOD + DAY),
      });
      const before = await rowsOf(id);
      let checks = 0;
      const base = dbMock.dbWrite.$queryRaw.getMockImplementation();
      dbMock.dbWrite.$queryRaw.mockImplementation(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (/AS eligible/.test(toSql(strings)) && (checks += 1) === 2)
            await restoreTo(id, status);
          return base?.(strings, ...values);
        }
      );

      const out = await reapDeletedAppStorage({ store: maint, now: NOW, batchRows: 1 });

      expect(out).toMatchObject({ scanned: 1, stopped: 1, purged: 0, rows: 1 });
      expect(await rowsOf(id)).toBe(before - 1);
      expect(await purgedAt(id)).toBeNull();
    });
  }

  // The last `proceed` check passed and the data is gone; the restore lands before the stamp.
  for (const status of ['approved', 'pending'] as const) {
    it(`doesn't stamp a purge when the block is restored to ${status} after the last batch`, async () => {
      const id = await app(`STAMP${status.toUpperCase()}`, {
        status: 'suspended',
        deletedAt: ago(PERIOD + DAY),
      });
      const base = dbMock.dbWrite.$executeRaw.getMockImplementation();
      dbMock.dbWrite.$executeRaw.mockImplementation(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          if (/SET storage_purged_at/.test(toSql(strings))) await restoreTo(id, status);
          return base?.(strings, ...values);
        }
      );

      const out = await reapDeletedAppStorage({ store: maint, now: NOW });

      expect(await rowsOf(id)).toBe(0);
      expect(out.stopped).toBe(0);
      expect(await purgedAt(id)).toBeNull();
    });
  }
});

describe('the reaper before its migrations are applied', () => {
  let noPolicy: Harness;
  const runJob = () =>
    (reapDeletedAppStorageJob as unknown as { fn: (c: unknown) => Promise<unknown> }).fn({
      checkIfCanceled: () => undefined,
    });
  const errorLogs = () =>
    loggingMock.logToAxiom.mock.calls.filter(([e]) => {
      const entry = e as { name?: string; type?: string };
      return entry?.name === 'reap-deleted-app-storage' && entry?.type === 'error';
    }).length;
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  beforeAll(async () => {
    noPolicy = await createPgliteHarness({ rls: true, appPurgePolicy: false });
  });
  afterAll(async () => {
    if (noPolicy) expect(noPolicy.violations).toEqual([]);
    await noPolicy?.close();
  });
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    loggingMock.logToAxiom.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    live.store = maint;
  });

  it('a missing migration stops the run with nothing deleted, and is logged once a day per migration', async () => {
    const s = createDocStore({ db: noPolicy.db });
    live.store = createDocStoreMaintenance({ db: noPolicy.db });
    const ids: string[] = [];
    for (const tag of ['NOPOLA', 'NOPOLB']) {
      const id = freshApp(tag);
      await s.put(ctx(id, NS_PROD, USERS[0]), PREFS, 'p', { a: 1 });
      await main.query(
        `INSERT INTO app_blocks (id, status, storage_deleted_at, updated_at) VALUES ($1, 'suspended', $2, $3)`,
        [id, ago(PERIOD + DAY), ago(PERIOD + DAY + HOUR)]
      );
      ids.push(id);
    }
    const before = await Promise.all(ids.map((id) => rowsOf(id, noPolicy)));
    expect(before.every((n) => n > 0)).toBe(true);
    const policy = { migrationPending: '20261102120000_appdata_app_purge.sql' };

    // The datastore's app-purge policy: one log for two apps, none an hour later, one a day and
    // an hour after the first.
    vi.setSystemTime(NOW);
    expect(await runJob()).toEqual(policy);
    expect(errorLogs()).toBe(1);
    vi.setSystemTime(at(HOUR));
    expect(await runJob()).toEqual(policy);
    expect(errorLogs()).toBe(1);
    vi.setSystemTime(at(25 * HOUR));
    expect(await runJob()).toEqual(policy);
    expect(errorLogs()).toBe(2);
    expect(await Promise.all(ids.map((id) => rowsOf(id, noPolicy)))).toEqual(before);
    for (const id of ids) expect(await purgedAt(id)).toBeNull();

    // The main database's columns, as Prisma raises a raw query naming a column the table does
    // not have yet: a different migration, so its first failure is logged although the policy's
    // was an hour ago.
    dbMock.dbWrite.$queryRaw.mockImplementation(async () => {
      throw Object.assign(
        new Error(
          'Raw query failed. Code: `42703`. Message: `column b.storage_deleted_at does not exist`'
        ),
        { code: 'P2010', meta: { code: '42703' } }
      );
    });
    const columns = { migrationPending: '20261218120000_app_block_storage_deleted_at' };
    vi.setSystemTime(at(26 * HOUR));
    expect(await runJob()).toEqual(columns);
    expect(errorLogs()).toBe(3);
    vi.setSystemTime(at(27 * HOUR));
    expect(await runJob()).toEqual(columns);
    expect(errorLogs()).toBe(3);
  });

  it('control: any other failure is an error, logged on every run', async () => {
    dbMock.dbWrite.$queryRaw.mockImplementation(async () => {
      throw new Error('connection reset');
    });

    vi.setSystemTime(NOW);
    expect(await runJob()).toEqual({ error: true });
    vi.setSystemTime(at(HOUR));
    expect(await runJob()).toEqual({ error: true });
    expect(errorLogs()).toBe(2);
  });
});
