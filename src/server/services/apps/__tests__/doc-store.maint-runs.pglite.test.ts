import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createDocStoreMaintenance,
  type DocStoreMaintenance,
  type PurgeDump,
} from '~/server/services/apps/doc-store';
import { createPgliteHarness, type Harness } from './doc-store.harness';
import { expectCode, freshApp, NS_PROD } from './doc-store.functional';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * THE MAINTENANCE RUNS left by rollout step 4 (`docs/app-storage-generic-core.md`, "Data
 * migration"): the tooling that wrote them is removed (rollout step 5), so these rows are seeded
 * here exactly as it wrote them (superuser inserts), and the store's remaining readers are run
 * against them on PGlite with RLS on: `listMaintRuns`, `purgeDump`, the dump retention
 * (`expireMaintDumps`) and the account wipe's scrub (`wipeAccount` → `scrubMaintRuns`), including
 * a user the runs are the ONLY trace of.
 */

// Pairwise distinct, and distinct from every id the other suites use.
const V1 = 7_101;
const V2 = 7_202;
const V3 = 7_303;
/** Only ever named by a dumped report: no document, usage row or mark anywhere. */
const V4 = 7_404;
const MOD = 9_027;
const RUN = '01JDMAINTRUN0000000000000A';

let h: Harness;
let maint: DocStoreMaintenance;

beforeAll(async () => {
  h = await createPgliteHarness({ rls: true });
  maint = createDocStoreMaintenance({ db: h.db });
});
afterAll(async () => {
  if (h) expect(h.violations).toEqual([]);
  await h?.close();
});

const DUMP: PurgeDump = {
  docs: [
    {
      key: 'song_a',
      data: {},
      version: 1,
      seq: 3,
      sizeBytes: 40,
      authorUid: V1,
      authorKind: 'counter',
      lastWriterUid: V1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      hiddenAt: null,
      hiddenBy: null,
      reportsDismissedAt: null,
    },
    {
      key: 'song_b',
      data: {},
      version: 1,
      seq: 5,
      sizeBytes: 41,
      authorUid: V2,
      authorKind: 'counter',
      lastWriterUid: V1,
      createdAt: '2026-11-02T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      hiddenAt: null,
      hiddenBy: null,
      reportsDismissedAt: '2026-11-03T00:00:00.000Z',
    },
  ],
  index: [],
  tallies: [
    { key: 'song_a', kind: 'counter', name: 'plays', count: 4 },
    { key: 'song_b', kind: 'counter', name: 'plays', count: 1 },
  ],
  marks: [
    { key: 'song_a', name: 'played', userId: V3, reason: null, createdAt: '2026-11-04T00:00:00Z' },
    { key: 'song_b', name: 'played', userId: V1, reason: null, createdAt: '2026-11-04T00:00:00Z' },
    { key: 'song_b', name: 'report', userId: V4, reason: null, createdAt: '2026-11-04T00:00:00Z' },
  ],
};

async function insertRun(
  app: string,
  row: {
    coll: string;
    kind: 'mark_migration' | 'purge' | 'purge_dump';
    name: string;
    status: string;
    params?: unknown;
    result?: unknown;
    dump?: unknown;
  }
) {
  await h.raw(
    `INSERT INTO appdata.maint_run (app_id, ns, coll, kind, name, status, params, result, dump, actor_uid)
     VALUES ($1, 'prod', $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9)`,
    [
      app,
      row.coll,
      row.kind,
      row.name,
      row.status,
      JSON.stringify(row.params ?? {}),
      JSON.stringify(row.result ?? {}),
      row.dump === undefined ? null : JSON.stringify(row.dump),
      MOD,
    ]
  );
}

/** One finished purge (header + one dump batch) and one verified mark migration. */
async function seedRuns(app: string, purgeStatus = 'purged') {
  await insertRun(app, {
    coll: 'popular_plays',
    kind: 'purge',
    name: RUN,
    status: purgeStatus,
    params: { mode: 'purge', reason: 'retire the counter collection' },
    result: {
      batches: 1,
      deleted: 2,
      refunds: [
        { userId: V1, docs: 1, bytes: 40 },
        { userId: V2, docs: 1, bytes: 41 },
      ],
    },
  });
  await insertRun(app, {
    coll: 'popular_plays',
    kind: 'purge_dump',
    name: `${RUN}.000001`,
    status: 'dumped',
    params: { batch: 1 },
    result: { deleted: 2, bytes: 81 },
    dump: DUMP,
  });
  await insertRun(app, {
    coll: 'popular_plays',
    kind: 'mark_migration',
    name: 'played',
    status: 'verified',
    params: { to: 'plays', data: { count: 1 }, keyMap: null },
    result: {
      copy: { rows: 2, inserted: 2, existing: 0, overCeiling: [V1, V2] },
      verify: { ok: true, userSample: [{ id: String(V3) }, { id: String(V2) }] },
    },
  });
}

const dumpOf = (app: string) => maint.purgeDump(app, { collection: 'popular_plays', runId: RUN });

describe('reading the runs', () => {
  it('lists every run without its dump rows, and reads one purge dump whole', async () => {
    const app = freshApp('MRREAD');
    await seedRuns(app);
    const runs = await maint.listMaintRuns(app);
    expect(
      runs
        .map((r) => [r.kind, r.name, r.status, r.actorUid])
        .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1))
    ).toEqual([
      ['mark_migration', 'played', 'verified', MOD],
      ['purge', RUN, 'purged', MOD],
    ]);
    expect(await dumpOf(app)).toEqual(DUMP);
    // Positive control for the scope: another app sees none of it.
    const other = freshApp('MRREADOTHER');
    expect(await maint.listMaintRuns(other)).toEqual([]);
    expect(await dumpOf(other)).toBeNull();
  });

  it('refuses a malformed run id or collection before reading', async () => {
    const app = freshApp('MRBAD');
    await expectCode(
      maint.purgeDump(app, { collection: 'popular_plays', runId: 'not-a-ulid' }),
      'invalid_request'
    );
    await expectCode(
      maint.purgeDump(app, { collection: 'Bad-Name', runId: RUN }),
      'invalid_request'
    );
  });
});

describe('dump retention', () => {
  const age = (app: string, column: 'updated_at' | 'created_at', days: number) =>
    h.raw(
      `UPDATE appdata.maint_run SET ${column} = now() - make_interval(days => $2)
        WHERE app_id = $1 AND kind = 'purge'`,
      [app, days]
    );

  it('a finished purge keeps its dump for 30 days, then loses it; the header and its counts stay', async () => {
    const app = freshApp('MREXPIRE');
    await seedRuns(app);
    await age(app, 'updated_at', 29);
    expect(await maint.expireMaintDumps(app)).toEqual({ dumps: 0 });
    expect(await dumpOf(app)).not.toBeNull();
    await age(app, 'updated_at', 31);
    expect(await maint.expireMaintDumps(app)).toEqual({ dumps: 1 });
    expect(await dumpOf(app)).toBeNull();
    expect((await maint.listMaintRuns(app)).find((r) => r.kind === 'purge')).toMatchObject({
      status: 'purged',
      result: { deleted: 2 },
    });
  });

  it('an unfinished purge is abandoned 30 days after it STARTED, and its dump expires then', async () => {
    const app = freshApp('MRABANDON');
    await seedRuns(app, 'purging');
    await age(app, 'updated_at', 90);
    await age(app, 'created_at', 29);
    expect(await maint.expireMaintDumps(app)).toEqual({ dumps: 0 });
    expect((await maint.listMaintRuns(app)).find((r) => r.kind === 'purge')?.status).toBe(
      'purging'
    );
    await age(app, 'created_at', 31);
    expect(await maint.expireMaintDumps(app)).toEqual({ dumps: 1 });
    expect((await maint.listMaintRuns(app)).find((r) => r.kind === 'purge')?.status).toBe(
      'abandoned'
    );
  });
});

describe('the account wipe reaches the runs', () => {
  it('removes the user from every dump and run result, keeping what names others', async () => {
    const app = freshApp('MRWIPE');
    await seedRuns(app);
    const wiped = await maint.wipeAccount(V1);
    expect(wiped.namespaces.find((n) => n.appId === app)?.maintRunsScrubbed).toBe(3);
    const dump = await dumpOf(app);
    // V1 authored song_a (it goes whole, with its tally and V3's mark on it); song_b stays, its
    // last writer (V1) cleared, V1's own mark on it gone.
    expect(dump?.docs.map((d) => [d.key, d.authorUid, d.lastWriterUid])).toEqual([
      ['song_b', V2, null],
    ]);
    expect(dump?.tallies.map((t) => t.key)).toEqual(['song_b']);
    expect(dump?.marks.map((m) => `${m.key}|${m.name}|${m.userId}`)).toEqual([
      `song_b|report|${V4}`,
    ]);
    const runs = await maint.listMaintRuns(app);
    const header = runs.find((r) => r.kind === 'purge');
    expect((header?.result.refunds as { userId: number }[]).map((r) => r.userId)).toEqual([V2]);
    const migration = runs.find((r) => r.kind === 'mark_migration');
    expect((migration?.result.copy as { overCeiling: number[] }).overCeiling).toEqual([V2]);
    // Positive control: nothing in the runs still names V1.
    const naming = await h.raw(
      `SELECT count(*)::int AS n FROM appdata.maint_run
        WHERE app_id = $1 AND (dump::text ~ $2 OR result::text ~ $2)`,
      [app, `[^0-9]${V1}[^0-9]`]
    );
    expect(naming[0].n).toBe(0);
  });

  it("finds a user the runs are the only trace of (a dumped report), and removes them from a verify's sample", async () => {
    const app = freshApp('MRWIPEONLY');
    await seedRuns(app);
    // Positive control: nothing outside the runs names V4.
    expect(
      await h.raw(
        `SELECT 1 FROM appdata.usage_user WHERE user_id = $1 UNION ALL
         SELECT 1 FROM appdata.doc_mark WHERE user_id = $1`,
        [V4]
      )
    ).toEqual([]);
    const wiped = await maint.wipeAccount(V4);
    expect(wiped.namespaces.filter((n) => n.appId === app)).toMatchObject([
      { ns: NS_PROD, maintRunsScrubbed: 1, sharedDocs: 0 },
    ]);
    expect((await dumpOf(app))?.marks.map((m) => m.userId)).toEqual([V3, V1]);

    await maint.wipeAccount(V3);
    const migration = (await maint.listMaintRuns(app)).find((r) => r.kind === 'mark_migration');
    expect(
      (migration?.result.verify as { userSample: { id: string }[] }).userSample.map((u) => u.id)
    ).toEqual([String(V2)]);
  });
});
