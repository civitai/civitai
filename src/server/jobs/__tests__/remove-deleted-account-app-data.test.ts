import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
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
} from '~/server/services/apps/__tests__/doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const live = vi.hoisted(() => ({
  store: undefined as unknown,
  /** Legal-hold answers by user id; absent = not held, `null` = the hold could not be read. */
  holds: new Map<number, boolean | null>(),
}));
vi.mock('~/server/services/apps/doc-store-maintenance.instance', () => ({
  getDocStoreMaintenance: () => live.store,
}));
vi.mock('~/server/services/legal-hold.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isAccountUnderLegalHold: async (id: number) => (live.holds.has(id) ? live.holds.get(id) : false),
}));
vi.mock('../job', () => ({
  createJob: (name: string, cron: string, fn: (ctx: unknown) => unknown) => ({ name, cron, fn }),
}));

const { removeDeletedAccountAppData } = await import(
  '~/server/jobs/remove-deleted-account-app-data'
);

/**
 * The app-data removal job against the REAL store (embedded Postgres, the real migrations, the
 * least-privilege role, RLS on) and two more embedded Postgres instances standing in for the main
 * database's `User` table: a PRIMARY (behind `dbWrite`) and a REPLICA (behind `dbRead`). The
 * job's own SQL runs on them unchanged, so the worklist predicate, its paging and the grace are
 * the ones under test, not re-implementations. The run cursor's `KeyValue` row is in memory.
 *
 * Boundaries OVERSHOOT the 7-day grace on both sides by an hour, never sit on it.
 */

const NOW = new Date('2026-11-02T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
/** Deleted long enough ago that the 7-day grace is over. */
const PAST_GRACE = at(-(7 * DAY + HOUR));

// Pairwise distinct, and distinct from every id the other suites use.
const OPTED_IN = 8_101;
const OPTED_OUT = 8_202;
const RESTORED = 8_303;
const HELD = 8_404;
const LIVE_USER = 8_505;
const ALL = [OPTED_IN, OPTED_OUT, RESTORED, HELD, LIVE_USER];

type UserRow = { deletedAt: Date | null; meta: Record<string, unknown> };
const REQUESTED = { appDataRemoval: 'requested' };

let h: Harness;
let store: DocStore;
let maint: DocStoreMaintenance;
let primary: PGlite;
let replica: PGlite;
let apps: string[];
const keyValues = new Map<string, unknown>();

/** A Prisma tagged-template call as positional SQL. */
const toSql = (strings: TemplateStringsArray) =>
  strings.reduce((sql, part, i) => sql + (i === 0 ? '' : `$${i}`) + part, '');

const USER_DDL = `CREATE TABLE "User" (
  id int PRIMARY KEY,
  "deletedAt" timestamp(3),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb)`;

async function writeUser(db: PGlite, id: number, row: UserRow) {
  await db.query(
    `INSERT INTO "User" (id, "deletedAt", meta) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO UPDATE SET "deletedAt" = EXCLUDED."deletedAt", meta = EXCLUDED.meta`,
    [id, row.deletedAt, JSON.stringify(row.meta)]
  );
}

/** Writes the user on the primary and, unless `lagging`, on the replica too. */
async function setUser(id: number, row: UserRow, opts: { lagging?: boolean } = {}) {
  await writeUser(primary, id, row);
  if (!opts.lagging) await writeUser(replica, id, row);
}

async function markerOf(id: number): Promise<unknown> {
  const { rows } = await primary.query<{ m: unknown }>(
    `SELECT meta->>'appDataRemoval' AS m FROM "User" WHERE id = $1`,
    [id]
  );
  return rows[0]?.m ?? null;
}

/** Documents of `uid` across this test's apps: their private docs and the shared docs they wrote. */
async function docsOf(uid: number): Promise<number> {
  const [r] = await h.raw(
    `SELECT count(*)::int AS n FROM appdata.doc
      WHERE app_id = ANY($2::text[])
        AND (scope_uid = $1 OR (scope_uid = 0 AND author_kind = 'user' AND author_uid = $1))`,
    [uid, apps]
  );
  return Number(r.n);
}

async function seedDocs(uids: number[]) {
  for (const app of apps) {
    for (const uid of uids) {
      await store.put(ctx(app, NS_PROD, uid), PREFS, 'p', { uid });
      await store.put(ctx(app, NS_PROD, uid), POSTS, `post-${uid}`, { status: 'open' });
    }
  }
}

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  store = createDocStore({ db: h.db });
  maint = createDocStoreMaintenance({ db: h.db });
  live.store = maint;
  primary = new PGlite();
  replica = new PGlite();
  await primary.exec(USER_DDL);
  await replica.exec(USER_DDL);
});

afterAll(async () => {
  if (h) expect(h.violations).toEqual([]);
  await h?.close();
  await primary?.close();
  await replica?.close();
});

beforeEach(async () => {
  live.holds.clear();
  keyValues.clear();
  await primary.exec('DELETE FROM "User"');
  await replica.exec('DELETE FROM "User"');
  // Two apps; every user has a private and an authored shared document in each.
  apps = [freshApp('ACCTA'), freshApp('ACCTB')];
  await seedDocs(ALL);
  await setUser(OPTED_IN, { deletedAt: PAST_GRACE, meta: { ...REQUESTED } });
  await setUser(OPTED_OUT, { deletedAt: PAST_GRACE, meta: {} });
  // Restored before the job ran: `restoreUser` cleared deletedAt and dropped the request.
  await setUser(RESTORED, { deletedAt: null, meta: {} });
  await setUser(HELD, { deletedAt: PAST_GRACE, meta: { ...REQUESTED } });
  await setUser(LIVE_USER, { deletedAt: null, meta: {} });
  live.holds.set(HELD, true);

  dbMock.dbWrite.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await primary.query(toSql(strings), values)).rows
  );
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await primary.query(toSql(strings), values)).affectedRows ?? 0
  );
  dbMock.dbRead.$queryRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) =>
      (await replica.query(toSql(strings), values)).rows
  );
  dbMock.dbWrite.keyValue.findUnique.mockImplementation(
    async ({ where }: { where: { key: string } }) =>
      keyValues.has(where.key) ? { key: where.key, value: keyValues.get(where.key) } : null
  );
  dbMock.dbWrite.keyValue.upsert.mockImplementation(
    async ({
      where,
      create,
      update,
    }: {
      where: { key: string };
      create: { value: unknown };
      update: { value: unknown };
    }) => {
      keyValues.set(where.key, keyValues.has(where.key) ? update.value : create.value);
      return { key: where.key, value: keyValues.get(where.key) };
    }
  );
});

/** A maintenance object whose wipe throws for `failing` and otherwise is the real one. */
function storeFailingFor(failing: Set<number>): DocStoreMaintenance {
  return {
    ...maint,
    wipeAccount: async (uid, opts) => {
      if (failing.has(uid)) throw new Error(`wipe failed for ${uid}`);
      return maint.wipeAccount(uid, opts);
    },
  };
}

describe('removeDeletedAccountAppData', () => {
  it("opt-in on: wipes that account's data in every app and nobody else's; opt-in off leaves it", async () => {
    for (const uid of ALL) expect({ uid, docs: await docsOf(uid) }).toEqual({ uid, docs: 4 });

    const out = await removeDeletedAccountAppData({ store: maint, now: NOW });

    expect(out).toMatchObject({ scanned: 2, wiped: 1, held: 1, failed: 0 });
    expect(await docsOf(OPTED_IN)).toBe(0);
    // Box left off, restored, held, never deleted: every document stays.
    for (const uid of [OPTED_OUT, RESTORED, HELD, LIVE_USER]) {
      expect({ uid, docs: await docsOf(uid) }).toEqual({ uid, docs: 4 });
    }
    // The request is done; the held one is kept for a later run.
    expect(await markerOf(OPTED_IN)).toBeNull();
    expect(await markerOf(HELD)).toBe('requested');
  });

  it('is idempotent: a second run wipes nothing more', async () => {
    await removeDeletedAccountAppData({ store: maint, now: NOW });
    const out = await removeDeletedAccountAppData({ store: maint, now: NOW });
    expect(out).toMatchObject({ wiped: 0, failed: 0 });
    expect(await docsOf(OPTED_OUT)).toBe(4);
    expect(await docsOf(HELD)).toBe(4);
  });

  it('re-checks the account on the primary: one restored after the replica last saw it is not wiped', async () => {
    // The replica still shows the request; the primary already has the restore.
    await writeUser(primary, OPTED_IN, { deletedAt: null, meta: {} });

    const out = await removeDeletedAccountAppData({ store: maint, now: NOW });

    expect(out.wiped).toBe(0);
    expect(await docsOf(OPTED_IN)).toBe(4);
  });

  it('reads the worklist from the replica: an account the replica has not caught up on waits for a later run', async () => {
    const LAGGED = 8_606;
    await seedDocs([LAGGED]);
    await setUser(LAGGED, { deletedAt: PAST_GRACE, meta: { ...REQUESTED } }, { lagging: true });

    await removeDeletedAccountAppData({ store: maint, now: NOW });
    expect(await docsOf(LAGGED)).toBe(4);
    expect(await markerOf(LAGGED)).toBe('requested');

    // The replica catches up; the next run wipes it.
    await writeUser(replica, LAGGED, { deletedAt: PAST_GRACE, meta: { ...REQUESTED } });
    await removeDeletedAccountAppData({ store: maint, now: NOW });
    expect(await docsOf(LAGGED)).toBe(0);
    expect(await markerOf(LAGGED)).toBeNull();
  });

  it('waits out the 7-day grace after the deletion before wiping', async () => {
    const IN_GRACE = 8_707;
    await seedDocs([IN_GRACE]);
    // Deleted 7 days minus an hour before NOW: still inside the grace.
    await setUser(IN_GRACE, { deletedAt: at(-(7 * DAY - HOUR)), meta: { ...REQUESTED } });

    await removeDeletedAccountAppData({ store: maint, now: NOW });
    expect(await docsOf(IN_GRACE)).toBe(4);
    expect(await markerOf(IN_GRACE)).toBe('requested');
    // The account past the grace went in the same run.
    expect(await docsOf(OPTED_IN)).toBe(0);

    // Two hours later the grace is over (7 days + 1 hour).
    await removeDeletedAccountAppData({ store: maint, now: at(2 * HOUR) });
    expect(await docsOf(IN_GRACE)).toBe(0);
    expect(await markerOf(IN_GRACE)).toBeNull();
  });

  it('a restore during the grace withdraws the request: nothing is wiped after the grace ends', async () => {
    const IN_GRACE = 8_717;
    await seedDocs([IN_GRACE]);
    await setUser(IN_GRACE, { deletedAt: at(-DAY), meta: { ...REQUESTED } });
    // Restored on day 2 (what `restoreUser` writes).
    await setUser(IN_GRACE, { deletedAt: null, meta: {} });

    await removeDeletedAccountAppData({ store: maint, now: at(10 * DAY) });
    expect(await docsOf(IN_GRACE)).toBe(4);
  });

  it('a legal hold placed during the grace stops the wipe after the grace ends', async () => {
    const IN_GRACE = 8_727;
    await seedDocs([IN_GRACE]);
    await setUser(IN_GRACE, { deletedAt: at(-DAY), meta: { ...REQUESTED } });
    live.holds.set(IN_GRACE, true);

    const out = await removeDeletedAccountAppData({ store: maint, now: at(10 * DAY) });
    expect(out.held).toBeGreaterThanOrEqual(1);
    expect(await docsOf(IN_GRACE)).toBe(4);
    expect(await markerOf(IN_GRACE)).toBe('requested');
  });

  it('a hold that cannot be read counts as held: nothing is wiped and the request is kept', async () => {
    live.holds.set(OPTED_IN, null);

    const out = await removeDeletedAccountAppData({ store: maint, now: NOW });

    expect(out).toMatchObject({ wiped: 0, held: 2, failed: 0 });
    expect(await docsOf(OPTED_IN)).toBe(4);
    expect(await markerOf(OPTED_IN)).toBe('requested');
  });

  it('does not stall behind held or failing accounts: a later account is still reached', async () => {
    // Three held and two failing accounts are the oldest deletions; LATER is the newest.
    const H = [8_811, 8_812, 8_813];
    const F = [8_821, 8_822];
    const LATER = 8_831;
    await seedDocs([...H, ...F, LATER]);
    let minutes = 0;
    for (const id of [...H, ...F, LATER]) {
      minutes += 1;
      await setUser(id, { deletedAt: at(-(30 * DAY) + minutes * 60_000), meta: { ...REQUESTED } });
    }
    for (const id of H) live.holds.set(id, true);
    // The fixture's own two requested accounts are out of the way.
    await setUser(OPTED_IN, { deletedAt: PAST_GRACE, meta: {} });
    await setUser(HELD, { deletedAt: PAST_GRACE, meta: {} });
    const failing = storeFailingFor(new Set(F));

    // At most 2 wipe attempts and 4 accounts looked at per run: the five accounts in front of
    // LATER fill more than one run.
    for (let run = 0; run < 3; run += 1) {
      await removeDeletedAccountAppData({ store: failing, now: NOW, batch: 2, scan: 4 });
    }

    expect(await docsOf(LATER)).toBe(0);
    expect(await markerOf(LATER)).toBeNull();
    // The held and failing accounts keep their data and their requests.
    for (const id of [...H, ...F]) {
      expect({ id, docs: await docsOf(id), marker: await markerOf(id) }).toEqual({
        id,
        docs: 4,
        marker: 'requested',
      });
    }

    // They are retried, not dropped: once a hold is released, a later run reaches it.
    live.holds.delete(H[0]);
    for (let run = 0; run < 4; run += 1) {
      await removeDeletedAccountAppData({ store: failing, now: NOW, batch: 2, scan: 4 });
    }
    expect(await docsOf(H[0])).toBe(0);
    expect(await markerOf(H[0])).toBeNull();
  });

  for (const change of ['restored', 'held'] as const) {
    it(`stops mid-wipe, before the next namespace, when the account is ${change} during the wipe`, async () => {
      let calls = 0;
      const racing: DocStoreMaintenance = {
        ...maint,
        wipeAccount: (uid, opts) =>
          maint.wipeAccount(uid, {
            ...opts,
            proceed: async () => {
              calls += 1;
              // After the first namespace is wiped, before the second.
              if (calls === 2 && uid === OPTED_IN) {
                if (change === 'restored') {
                  await writeUser(primary, OPTED_IN, { deletedAt: null, meta: {} });
                } else {
                  live.holds.set(OPTED_IN, true);
                }
              }
              return (await opts?.proceed?.()) ?? true;
            },
          }),
      };

      const out = await removeDeletedAccountAppData({ store: racing, now: NOW });

      expect(calls).toBeGreaterThanOrEqual(2);
      expect(out).toMatchObject({ wiped: 0, stopped: 1 });
      // One app's two documents went; the other app's two stay.
      expect(await docsOf(OPTED_IN)).toBe(2);
      expect(await markerOf(OPTED_IN)).toBe(change === 'held' ? 'requested' : null);
    });
  }
});
