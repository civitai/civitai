import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  CoocCountAccumulator,
  serializeCoocCounts,
  serializeTrainImageIds,
  type CoocCounts,
} from '~/server/services/resource-intent-cooc/build';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import {
  applyCoocRetention,
  assertSnapshotPrecedesWindow,
  beginCoocBuild,
  completeCoocBuild,
  coocContentHash,
  CoocSnapshotExpiredError,
  CoocSnapshotHashMismatchError,
  latestReadySnapshotId,
  loadCoocSnapshot,
  releaseCoocSnapshot,
  type CoocBuildResult,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import { asFixtureWriter, freshDb, ids, seed } from './resource-intent-cooc.harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = new Date('2026-10-08T12:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const ahead = (d: number) => new Date(NOW.getTime() + d * DAY);

const golden = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/resource-intent-cooc-golden.json'), 'utf8')
) as { rows: [string, [number, string][]][] };
const goldenRows = golden.rows.map(([t, m]) => ({ tokens: t ? t.split(' ') : [], models: m }));
function countsOf(rows: typeof goldenRows): CoocCounts {
  const acc = new CoocCountAccumulator(RESOURCE_INTENT_COOC_SPEC.addonTypes);
  for (const r of rows) acc.add(r.tokens, r.models);
  const {
    rawPairs: _raw,
    rawVocab: _rawVocab,
    typeConflicts: _typeConflicts,
    ...counts
  } = acc.finalize(RESOURCE_INTENT_COOC_SPEC);
  return counts;
}
const COUNTS = countsOf(goldenRows);

async function result(counts = COUNTS): Promise<CoocBuildResult> {
  return {
    payload: await serializeCoocCounts(counts),
    trainImageIds: await serializeTrainImageIds([3, 1, 2]),
    trainCreatedAtMin: ago(130),
    trainCreatedAtMax: ago(11),
    idsTried: 10,
    trainRows: counts.N,
    vocab: counts.vocab.length,
    models: counts.modelIds.length,
    keptPairs: counts.modelIdx.length,
  };
}
const begin = (
  sql: CoocSql,
  kind: 'production' | 'study',
  over: Partial<{ trainEnd: Date; pinnedUntil: Date | null }> = {}
) =>
  beginCoocBuild(sql, {
    kind,
    specHash: 'spec',
    trainStart: ago(130),
    trainEnd: over.trainEnd ?? ago(10),
    seed: 1,
    pinnedUntil:
      over.pinnedUntil !== undefined
        ? over.pinnedUntil
        : kind === 'study'
        ? new Date(Date.now() + 30 * DAY)
        : null,
    now: new Date(),
  });

describe('cooc store on the real migration', () => {
  it('round-trips a ready build and verifies its content hash on load', async () => {
    const { sql } = await freshDb();
    const { id } = await begin(sql, 'production');
    const r = await result();
    const { contentHash, created } = await completeCoocBuild(sql, id, r);
    expect(created).toBe(true);
    expect(contentHash).toBe(coocContentHash('production', r.payload));
    expect(await latestReadySnapshotId(sql)).toBe(contentHash);
    const loaded = await loadCoocSnapshot(sql, contentHash, { kind: 'production', now: NOW });
    expect(loaded.counts).toEqual(COUNTS);
    expect(loaded.meta.status).toBe('ready');
  });

  it('refuses a payload whose bytes no longer match the content hash', async () => {
    const { db, sql } = await freshDb();
    const { id } = await begin(sql, 'production');
    const { contentHash } = await completeCoocBuild(sql, id, await result());
    await asFixtureWriter(db, () =>
      db.query(
        `UPDATE "ResourceIntentCoocSnapshot" SET "payload" = "payload" || '\\x00'::bytea WHERE "id" = $1`,
        [id]
      )
    );
    await expect(
      loadCoocSnapshot(sql, contentHash, { kind: 'production', now: NOW })
    ).rejects.toBeInstanceOf(CoocSnapshotHashMismatchError);
  });

  it('the same content twice under one kind keeps one ready row; the second is a duplicate', async () => {
    const { db, sql } = await freshDb();
    const r = await result();
    const a = await completeCoocBuild(sql, (await begin(sql, 'production')).id, r);
    const b = await completeCoocBuild(sql, (await begin(sql, 'production')).id, r);
    expect([a.created, b.created]).toEqual([true, false]);
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentCoocSnapshot" ORDER BY "status"`
    );
    expect(st.rows.map((x) => x.status)).toEqual(['duplicate', 'ready']);
  });
});

describe('cooc loader', () => {
  it('refuses an expired study snapshot even before retention runs', async () => {
    const { sql } = await freshDb();
    const pin = new Date(Date.now() + 2 * DAY);
    const { contentHash } = await completeCoocBuild(
      sql,
      (
        await begin(sql, 'study', { pinnedUntil: pin })
      ).id,
      await result()
    );
    await expect(
      loadCoocSnapshot(sql, contentHash, { kind: 'study', now: new Date(pin.getTime() - 1) })
    ).resolves.toBeDefined();
    await expect(
      loadCoocSnapshot(sql, contentHash, { kind: 'study', now: pin })
    ).rejects.toBeInstanceOf(CoocSnapshotExpiredError);
  });
});

describe('cooc served snapshot', () => {
  it('a study snapshot built later is never returned as latest', async () => {
    const { db, sql } = await freshDb();
    await seed(db, { kind: 'production', trainEnd: ago(9), builtAt: ago(8), contentHash: 'P' });
    await seed(db, {
      kind: 'study',
      trainEnd: ago(1),
      builtAt: ago(0.5),
      pinnedUntil: ahead(10),
      contentHash: 'S',
    });
    expect(await latestReadySnapshotId(sql)).toBe('P');
  });

  it('backfill: a later-built production snapshot with an older trainEnd does not displace the served one', async () => {
    const { db, sql } = await freshDb();
    await seed(db, {
      kind: 'production',
      trainEnd: ago(9),
      builtAt: ago(8),
      contentHash: 'SERVED',
    });
    await seed(db, {
      kind: 'production',
      trainEnd: ago(40),
      builtAt: ago(0.1),
      contentHash: 'BACKFILL',
    });
    expect(await latestReadySnapshotId(sql)).toBe('SERVED');
    // Same trainEnd: the later build wins.
    await seed(db, {
      kind: 'production',
      trainEnd: ago(9),
      builtAt: ago(1),
      contentHash: 'REBUILT',
    });
    expect(await latestReadySnapshotId(sql)).toBe('REBUILT');
  });

  it('a newer failed build is never served', async () => {
    const { db, sql } = await freshDb();
    await seed(db, { kind: 'production', trainEnd: ago(9), builtAt: ago(8), contentHash: 'P' });
    await seed(db, { kind: 'production', status: 'failed', trainEnd: ago(1), builtAt: ago(0.5) });
    await seed(db, { kind: 'production', status: 'building', trainEnd: ago(1), builtAt: ago(0.1) });
    expect(await latestReadySnapshotId(sql)).toBe('P');
  });
});

describe('cooc retention', () => {
  it('deletes a 5-week-old production snapshot, keeps a 3-week-old one and the served one', async () => {
    const { db, sql } = await freshDb();
    const served = await seed(db, { kind: 'production', trainEnd: ago(2), builtAt: ago(1) });
    const recent = await seed(db, { kind: 'production', trainEnd: ago(22), builtAt: ago(21) });
    const old = await seed(db, { kind: 'production', trainEnd: ago(36), builtAt: ago(35) });
    const { deleted } = await applyCoocRetention(sql, NOW);
    expect(deleted).toEqual([old]);
    expect((await ids(db)).sort()).toEqual([served, recent].sort());
  });

  it('keeps the served production snapshot however old it is', async () => {
    const { db, sql } = await freshDb();
    const served = await seed(db, { kind: 'production', trainEnd: ago(91), builtAt: ago(90) });
    await applyCoocRetention(sql, NOW);
    expect(await ids(db)).toEqual([served]);
  });

  it('a pinned study survives until its pin, and goes on the sweep at the pin', async () => {
    const { db, sql } = await freshDb();
    const pin = ahead(3);
    const study = await seed(db, {
      kind: 'study',
      trainEnd: ago(30),
      builtAt: ago(40),
      pinnedUntil: pin,
    });
    await applyCoocRetention(sql, NOW);
    await applyCoocRetention(sql, new Date(pin.getTime() - 1));
    expect(await ids(db)).toEqual([study]);
    const { deleted } = await applyCoocRetention(sql, pin);
    expect(deleted).toEqual([study]);
  });

  it('five weeks of failed builds never delete the last ready snapshot', async () => {
    const { db, sql } = await freshDb();
    const lastReady = await seed(db, { kind: 'production', trainEnd: ago(41), builtAt: ago(40) });
    const failed: string[] = [];
    for (let w = 0; w < 5; w++)
      failed.push(
        await seed(db, {
          kind: 'production',
          status: 'failed',
          trainEnd: ago(7 * w + 1),
          builtAt: ago(7 * w + 0.5),
        })
      );
    for (let d = 0; d < 35; d++)
      await applyCoocRetention(sql, new Date(NOW.getTime() - (35 - d) * DAY));
    await applyCoocRetention(sql, NOW);
    // Only the newest failure (half a day old) is within 7 days; the ready one is kept.
    expect((await ids(db)).sort()).toEqual([lastReady, failed[0]].sort());
  });
});

describe('cooc release', () => {
  it('deletes a study snapshot immediately; --dry-run deletes nothing', async () => {
    const { db, sql } = await freshDb();
    const { contentHash } = await completeCoocBuild(
      sql,
      (
        await begin(sql, 'study')
      ).id,
      await result()
    );
    const dry = await releaseCoocSnapshot(sql, contentHash, { dryRun: true });
    expect(dry.deleted).toBe(false);
    expect((await ids(db)).length).toBe(1);
    const real = await releaseCoocSnapshot(sql, contentHash, { dryRun: false });
    expect(real).toEqual({ id: dry.id, deleted: true });
    expect(await ids(db)).toEqual([]);
  });
});

describe('cooc study window guard', () => {
  it('requires every training image before trainEnd, and trainEnd a gap before the window', () => {
    const meta = { trainEnd: ago(10), trainCreatedAtMax: ago(10.5) };
    expect(() => assertSnapshotPrecedesWindow(meta, ago(9), 1)).not.toThrow();
    expect(() => assertSnapshotPrecedesWindow(meta, ago(9.5), 1)).toThrow(/before the window/);
    expect(() =>
      assertSnapshotPrecedesWindow({ trainEnd: ago(10), trainCreatedAtMax: ago(10) }, ago(1), 1)
    ).toThrow(/at or after its trainEnd/);
  });
});
