import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import {
  CoocCountAccumulator,
  COOC_MAX_PAYLOAD_BYTES,
  deserializeCoocCounts,
  serializeCoocCounts,
  serializeTrainImageIds,
  type CoocCounts,
} from '~/server/services/resource-intent-cooc/build';
import { RESOURCE_INTENT_COOC_SPEC } from '~/server/services/resource-intent-cooc/spec';
import {
  applyCoocRetention,
  assertCoocPin,
  assertSnapshotPrecedesWindow,
  beginCoocBuild,
  completeCoocBuild,
  coocContentHash,
  CoocRetentionOverdueError,
  CoocSnapshotExpiredError,
  CoocSnapshotHashMismatchError,
  CoocSnapshotKindMismatchError,
  CoocStudyDuplicateError,
  failCoocBuild,
  latestReadySnapshotId,
  loadCoocSnapshot,
  releaseCoocSnapshot,
  selectCoocSnapshotsToDelete,
  type CoocBuildResult,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import { asFixtureWriter, freshDb, ids, MIGRATION_SQL, seed } from './resource-intent-cooc.harness';

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

describe('cooc snapshot payload', () => {
  it('round-trips through serialize/deserialize unchanged', async () => {
    expect(await deserializeCoocCounts(await serializeCoocCounts(COUNTS))).toEqual(COUNTS);
  });

  it('is deterministic, and independent of input order', async () => {
    const a = await serializeCoocCounts(COUNTS);
    const b = await serializeCoocCounts(countsOf(goldenRows));
    const shuffled = [...goldenRows]
      .reverse()
      .map((r) => ({ tokens: [...r.tokens].reverse(), models: [...r.models].reverse() }));
    const c = await serializeCoocCounts(countsOf(shuffled));
    expect(Buffer.compare(a, b)).toBe(0);
    expect(Buffer.compare(a, c)).toBe(0);
  });

  it('the content hash is sha256(kind, NUL, payload)', async () => {
    const p = await serializeCoocCounts(COUNTS);
    const want = createHash('sha256')
      .update(Buffer.concat([Buffer.from('study\0'), p]))
      .digest('hex');
    expect(coocContentHash('study', p)).toBe(want);
    expect(coocContentHash('production', p)).not.toBe(want);
  });

  it('refuses a payload above the size ceiling, and a screen-scale build fits under it', async () => {
    await expect(deserializeCoocCounts(Buffer.alloc(COOC_MAX_PAYLOAD_BYTES + 1))).rejects.toThrow(
      /exceeds/
    );
    const { sql } = await freshDb();
    const { id } = await begin(sql, 'production');
    await expect(
      completeCoocBuild(sql, id, {
        ...(await result()),
        payload: Buffer.alloc(COOC_MAX_PAYLOAD_BYTES + 1),
      })
    ).rejects.toThrow(/exceeds/);
    // Screen-scale V/M/P; random counts compress worst, so the payload must still fit.
    let x = 7;
    const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const V = 116_533;
    const M = 72_977;
    const P = 1_570_000;
    const ptr = new Uint32Array(V + 1);
    for (let t = 0; t < V; t++) ptr[t + 1] = Math.min(P, Math.round(((t + 1) / V) * P));
    const modelIdx = new Uint32Array(P);
    const c = new Uint32Array(P);
    for (let t = 0; t < V; t++) {
      let m = 0;
      for (let k = ptr[t]; k < ptr[t + 1]; k++) {
        m += 1 + Math.floor(rnd() * 3);
        modelIdx[k] = m;
        c[k] = 2 + Math.floor(rnd() * 50);
      }
    }
    const big: CoocCounts = {
      N: 206_598,
      vocab: Array.from({ length: V }, (_, i) => `tok${String(i).padStart(6, '0')}`),
      modelIds: Array.from({ length: M }, (_, i) => 1 + i * 13),
      modelTypes: Array.from({ length: M }, (_, i) => (i % 5 ? 'LORA' : 'TextualInversion')),
      nT: new Uint32Array(V).fill(100_000),
      nM: new Uint32Array(M).fill(100_000),
      ptr,
      modelIdx,
      c,
    };
    const p = await serializeCoocCounts(big);
    expect(p.length).toBeGreaterThan(100_000);
    expect(p.length).toBeLessThan(COOC_MAX_PAYLOAD_BYTES / 8);
  });
});

describe('cooc store on the real migration', () => {
  it('the migration is re-runnable', async () => {
    const { db } = await freshDb();
    await expect(db.exec(MIGRATION_SQL)).resolves.toBeDefined();
  });

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

  it('a ready study build and a ready production build of the same data have distinct content hashes', async () => {
    const { db, sql } = await freshDb();
    const r = await result();
    const prod = await completeCoocBuild(sql, (await begin(sql, 'production')).id, r);
    const study = await completeCoocBuild(sql, (await begin(sql, 'study')).id, r);
    expect(prod.created && study.created).toBe(true);
    expect(study.contentHash).not.toBe(prod.contentHash);
    const ready = await db.query<{ kind: string; contentHash: string }>(
      `SELECT "kind", "contentHash" FROM "ResourceIntentCoocSnapshot" WHERE "status" = 'ready' ORDER BY "kind"`
    );
    expect(ready.rows).toEqual([
      { kind: 'production', contentHash: prod.contentHash },
      { kind: 'study', contentHash: study.contentHash },
    ]);
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

  it('a second study build of the same content fails loudly instead of sharing the first pin', async () => {
    const { db, sql } = await freshDb();
    const r = await result();
    const first = await completeCoocBuild(sql, (await begin(sql, 'study')).id, r);
    const second = (await begin(sql, 'study', { pinnedUntil: new Date(Date.now() + 50 * DAY) })).id;
    await expect(completeCoocBuild(sql, second, r)).rejects.toBeInstanceOf(CoocStudyDuplicateError);
    const st = await db.query<{ id: string; status: string; contentHash: string | null }>(
      `SELECT "id", "status", "contentHash" FROM "ResourceIntentCoocSnapshot"`
    );
    expect(st.rows.find((x) => x.id === second)?.status).toBe('duplicate');
    expect(st.rows.filter((x) => x.status === 'ready').map((x) => x.contentHash)).toEqual([
      first.contentHash,
    ]);
  });

  it('a concurrent identical build that wins the unique index makes this one a duplicate', async () => {
    const { db, sql } = await freshDb();
    const r = await result();
    await completeCoocBuild(sql, (await begin(sql, 'production')).id, r);
    const { id } = await begin(sql, 'production');
    // The pre-check misses the winner (it committed after the check), so the UPDATE hits the index.
    let hidden = true;
    const racing: CoocSql = {
      query: async <T>(q: Parameters<CoocSql['query']>[0]) => {
        if (
          hidden &&
          q.text.startsWith('\n    SELECT "id" FROM') &&
          q.text.includes('"contentHash" =')
        ) {
          hidden = false;
          return [] as T[];
        }
        return sql.query<T>(q);
      },
      execute: sql.execute,
    };
    expect(await completeCoocBuild(racing, id, r)).toMatchObject({ created: false });
    expect(hidden).toBe(false);
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentCoocSnapshot" ORDER BY "status"`
    );
    expect(st.rows.map((x) => x.status)).toEqual(['duplicate', 'ready']);
  });

  it('two failed builds are recorded as two distinct rows', async () => {
    const { db, sql } = await freshDb();
    const a = await begin(sql, 'production');
    const b = await begin(sql, 'production');
    await failCoocBuild(sql, a.id);
    await failCoocBuild(sql, b.id);
    expect(a.id).not.toBe(b.id);
    const rows = await db.query<{ status: string; contentHash: string | null }>(
      `SELECT "status", "contentHash" FROM "ResourceIntentCoocSnapshot"`
    );
    expect(rows.rows).toEqual([
      { status: 'failed', contentHash: null },
      { status: 'failed', contentHash: null },
    ]);
  });

  it('never writes builtAt: the database sets it, and a supplied one is refused', async () => {
    const { db, sql, statements } = await freshDb();
    const before = Date.now();
    // `now` far in the past: if the writer stored it, builtAt would be 2020.
    const { id, builtAt } = await beginCoocBuild(sql, {
      kind: 'production',
      specHash: 's',
      trainStart: ago(130),
      trainEnd: ago(10),
      seed: 1,
      pinnedUntil: null,
      now: new Date('2020-01-01T00:00:00Z'),
    });
    const [{ dbNow }] = (await db.query<{ dbNow: Date }>(`SELECT now()::timestamp(3) AS "dbNow"`))
      .rows;
    expect(Math.abs(builtAt.getTime() - dbNow.getTime())).toBeLessThan(60_000);
    expect(builtAt.getTime()).toBeGreaterThan(before - 3_600_000);
    const insert = statements.find((s) => s.includes('INSERT')) as string;
    // The column list and VALUES (everything before RETURNING) never name builtAt.
    expect(insert.split('RETURNING')[0]).not.toContain('"builtAt"');
    await completeCoocBuild(sql, id, await result());
    expect(statements.filter((s) => /UPDATE[\s\S]*"builtAt"/.test(s))).toEqual([]);
    const row = await db.query<{ builtAt: Date }>(
      `SELECT "builtAt" FROM "ResourceIntentCoocSnapshot"`
    );
    expect(row.rows[0].builtAt.getTime()).toBe(builtAt.getTime());
    await expect(
      beginCoocBuild(sql, {
        kind: 'production',
        specHash: 's',
        trainStart: ago(130),
        trainEnd: ago(10),
        seed: 1,
        pinnedUntil: null,
        now: NOW,
        builtAt: NOW,
      } as never)
    ).rejects.toThrow(/builtAt is set by the database/);
  });
});

describe('cooc row guard trigger', () => {
  it('overwrites a writer-supplied builtAt with the database clock', async () => {
    const { db } = await freshDb();
    await db.query(
      `INSERT INTO "ResourceIntentCoocSnapshot" ("kind","specHash","trainStart","trainEnd","seed","builtAt")
       VALUES ('production','s', now() - interval '130 days', now() - interval '10 days', 1, '2001-01-01')`
    );
    const r = await db.query<{ off: number }>(
      `SELECT abs(extract(epoch FROM (now()::timestamp(3) - "builtAt"))) AS "off" FROM "ResourceIntentCoocSnapshot"`
    );
    expect(Number(r.rows[0].off)).toBeLessThan(60);
  });

  it('refuses any change to a ready row, and any change of builtAt', async () => {
    const { db, sql } = await freshDb();
    const { id } = await begin(sql, 'production');
    await expect(
      db.query(`UPDATE "ResourceIntentCoocSnapshot" SET "builtAt" = '2001-01-01' WHERE "id" = $1`, [
        id,
      ])
    ).rejects.toThrow(/builtAt cannot change/);
    await completeCoocBuild(sql, id, await result());
    await expect(
      db.query(`UPDATE "ResourceIntentCoocSnapshot" SET "seed" = 2 WHERE "id" = $1`, [id])
    ).rejects.toThrow(/only a building row can change/);
    await expect(failCoocBuild(sql, id)).resolves.toBeUndefined(); // a no-op, not an error
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentCoocSnapshot"`
    );
    expect(st.rows[0].status).toBe('ready');
  });
});

describe('cooc pin rules (store and CHECK)', () => {
  const insertRaw = (
    db: Awaited<ReturnType<typeof freshDb>>['db'],
    kind: string,
    pin: string | null
  ) =>
    db.query(
      `INSERT INTO "ResourceIntentCoocSnapshot" ("kind","specHash","trainStart","trainEnd","seed","pinnedUntil")
       VALUES ($1, 's', now() - interval '130 days', now() - interval '10 days', 1, ${
         pin ?? 'NULL'
       })`,
      [kind]
    );

  it('a study row without a pin is rejected by the store and by the CHECK', async () => {
    const { db, sql } = await freshDb();
    await expect(begin(sql, 'study', { pinnedUntil: null })).rejects.toThrow(/requires a pin/);
    await expect(insertRaw(db, 'study', null)).rejects.toThrow(/kind_pin_check/);
    expect(await ids(db)).toEqual([]);
  });

  it('a pin beyond 58 days is rejected by the store and by the CHECK; 58 is accepted', async () => {
    const { db, sql } = await freshDb();
    const now = new Date();
    expect(() => assertCoocPin('study', new Date(now.getTime() + 58 * DAY + 1), now)).toThrow(
      /58 days/
    );
    expect(() => assertCoocPin('study', new Date(now.getTime() + 60 * DAY), now)).toThrow(
      /58 days/
    );
    expect(() => assertCoocPin('study', new Date(now.getTime() + 58 * DAY), now)).not.toThrow();
    expect(() => assertCoocPin('study', now, now)).toThrow(/after the build/);
    await expect(insertRaw(db, 'study', `now() + interval '59 days'`)).rejects.toThrow(
      /kind_pin_check/
    );
    await expect(insertRaw(db, 'study', `now() + interval '58 days'`)).resolves.toBeDefined();
    await expect(
      begin(sql, 'study', { pinnedUntil: new Date(Date.now() + 59 * DAY) })
    ).rejects.toThrow(/58 days/);
  });

  it('a study pin at or before the build is rejected by the CHECK', async () => {
    const { db } = await freshDb();
    await expect(insertRaw(db, 'study', `now() - interval '1 second'`)).rejects.toThrow(
      /kind_pin_check/
    );
    // builtAt is set to the same statement's now(), so a pin of now() is exactly the build.
    await expect(insertRaw(db, 'study', 'now()')).rejects.toThrow(/kind_pin_check/);
    await expect(insertRaw(db, 'study', `now() + interval '1 second'`)).resolves.toBeDefined();
  });

  it('a production row with a pin is rejected by the store and by the CHECK', async () => {
    const { db, sql } = await freshDb();
    await expect(begin(sql, 'production', { pinnedUntil: ahead(5) })).rejects.toThrow(
      /cannot be pinned/
    );
    await expect(insertRaw(db, 'production', `now() + interval '5 days'`)).rejects.toThrow(
      /kind_pin_check/
    );
  });

  it('a ready row must carry its hash and payload (CHECK)', async () => {
    const { db } = await freshDb();
    await expect(
      db.query(
        `INSERT INTO "ResourceIntentCoocSnapshot" ("kind","status","specHash","trainStart","trainEnd","seed")
         VALUES ('production','ready','s', now(), now(), 1)`
      )
    ).rejects.toThrow(/ready_check/);
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

  it('a study pinned to a production hash is refused, not served (and vice versa)', async () => {
    const { sql } = await freshDb();
    const prod = await completeCoocBuild(sql, (await begin(sql, 'production')).id, await result());
    const study = await completeCoocBuild(sql, (await begin(sql, 'study')).id, await result());
    await expect(
      loadCoocSnapshot(sql, prod.contentHash, { kind: 'study', now: NOW })
    ).rejects.toBeInstanceOf(CoocSnapshotKindMismatchError);
    await expect(
      loadCoocSnapshot(sql, study.contentHash, { kind: 'production', now: NOW })
    ).rejects.toBeInstanceOf(CoocSnapshotKindMismatchError);
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

  it('a full tie on trainEnd and builtAt is broken by the higher id, in SQL and in retention alike', async () => {
    const { db, sql } = await freshDb();
    const t = ago(9);
    const b = ago(8);
    await seed(db, { id: 'aaa', kind: 'production', trainEnd: t, builtAt: b, contentHash: 'A' });
    await seed(db, { id: 'zzz', kind: 'production', trainEnd: t, builtAt: b, contentHash: 'Z' });
    expect(await latestReadySnapshotId(sql)).toBe('Z');
    const rows = (
      await db.query<Parameters<typeof selectCoocSnapshotsToDelete>[0][number]>(
        `SELECT "id","kind","status","trainEnd","builtAt","pinnedUntil" FROM "ResourceIntentCoocSnapshot"`
      )
    ).rows;
    expect(selectCoocSnapshotsToDelete(rows, ahead(400))).toEqual(['aaa']);
  });

  it('retention protects exactly the row latestReadySnapshotId serves (random tables)', async () => {
    let x = 3;
    const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
    // One database, emptied per trial: a PGlite boot per trial puts this case near the test timeout.
    const { db, sql } = await freshDb();
    for (let trial = 0; trial < 25; trial++) {
      await db.exec(`DELETE FROM "ResourceIntentCoocSnapshot"`);
      const n = 1 + Math.floor(rnd() * 8);
      const hashToId = new Map<string, string>();
      for (let i = 0; i < n; i++) {
        const kind = rnd() < 0.7 ? 'production' : 'study';
        const status = rnd() < 0.7 ? 'ready' : 'failed';
        const builtAt = ago(Math.floor(rnd() * 60) + 0.5);
        const hash = `h${trial}-${i}`;
        const id = await seed(db, {
          kind,
          status,
          // Few distinct trainEnds and builtAts, so ties occur.
          trainEnd: ago(10 * Math.floor(rnd() * 4) + 2),
          builtAt,
          pinnedUntil: kind === 'study' ? new Date(builtAt.getTime() + 10 * DAY) : null,
          contentHash: hash,
        });
        hashToId.set(hash, id);
      }
      const served = await latestReadySnapshotId(sql);
      const all = (
        await db.query<{
          id: string;
          kind: 'production' | 'study';
          status: string;
          trainEnd: Date;
          builtAt: Date;
          pinnedUntil: Date | null;
        }>(
          `SELECT "id","kind","status","trainEnd","builtAt","pinnedUntil" FROM "ResourceIntentCoocSnapshot"`
        )
      ).rows;
      // Far in the future, everything but the served row is deletable.
      const kept = all
        .map((r) => r.id)
        .filter((id) => !selectCoocSnapshotsToDelete(all, ahead(400)).includes(id));
      expect(kept).toEqual(served ? [hashToId.get(served)] : []);
    }
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

  it('production and non-ready age limits are exact: 28 d and 7 d kept, a millisecond more deleted', async () => {
    const { db, sql } = await freshDb();
    await seed(db, { kind: 'production', trainEnd: ago(1), builtAt: ago(0.5) }); // served
    const p28 = await seed(db, { kind: 'production', trainEnd: ago(29), builtAt: ago(28) });
    const p28x = await seed(db, {
      kind: 'production',
      trainEnd: ago(30),
      builtAt: new Date(ago(28).getTime() - 1),
    });
    const f7 = await seed(db, {
      kind: 'production',
      status: 'failed',
      trainEnd: ago(8),
      builtAt: ago(7),
    });
    const f7x = await seed(db, {
      kind: 'production',
      status: 'failed',
      trainEnd: ago(8),
      builtAt: new Date(ago(7).getTime() - 1),
    });
    const { deleted } = await applyCoocRetention(sql, NOW);
    expect(deleted.sort()).toEqual([p28x, f7x].sort());
    expect(await ids(db)).toEqual(expect.arrayContaining([p28, f7]));
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

  it('deletes non-ready rows after 7 days, not before', async () => {
    const { db, sql } = await freshDb();
    const six = await seed(db, {
      kind: 'production',
      status: 'failed',
      trainEnd: ago(7),
      builtAt: ago(6),
    });
    const eight = await seed(db, {
      kind: 'production',
      status: 'building',
      trainEnd: ago(9),
      builtAt: ago(8),
    });
    const { deleted } = await applyCoocRetention(sql, NOW);
    expect(deleted).toEqual([eight]);
    expect(await ids(db)).toEqual([six]);
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

  it('a newer failed row never protects itself', async () => {
    const { db, sql } = await freshDb();
    const ready = await seed(db, { kind: 'production', trainEnd: ago(30), builtAt: ago(29) });
    const failedNewer = await seed(db, {
      kind: 'production',
      status: 'failed',
      trainEnd: ago(9),
      builtAt: ago(8),
    });
    const { deleted } = await applyCoocRetention(sql, NOW);
    expect(deleted).toEqual([failedNewer]);
    expect(await ids(db)).toEqual([ready]);
  });

  it('a failed study row goes at its pin, not after 7 days', async () => {
    const { db, sql } = await freshDb();
    const s = await seed(db, {
      kind: 'study',
      status: 'failed',
      trainEnd: ago(3),
      builtAt: ago(2),
      pinnedUntil: ago(1),
    });
    expect((await applyCoocRetention(sql, NOW)).deleted).toEqual([s]);
  });

  it('a sweep that leaves an overdue study row throws (so no heartbeat is written)', async () => {
    const { db, sql } = await freshDb();
    await seed(db, { kind: 'study', trainEnd: ago(30), builtAt: ago(40), pinnedUntil: ago(1) });
    const deafToDeletes: CoocSql = {
      query: sql.query,
      execute: async (s) => (s.text.startsWith('DELETE') ? 0 : sql.execute(s)),
    };
    await expect(applyCoocRetention(deafToDeletes, NOW)).rejects.toBeInstanceOf(
      CoocRetentionOverdueError
    );
  });

  it('a missing table is not an error', async () => {
    const { db, sql } = await freshDb();
    await db.exec('DROP TABLE "ResourceIntentCoocSnapshot"');
    expect(await applyCoocRetention(sql, NOW)).toEqual({ deleted: [], tableMissing: true });
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

  it('refuses a production snapshot', async () => {
    const { db, sql } = await freshDb();
    const { contentHash } = await completeCoocBuild(
      sql,
      (
        await begin(sql, 'production')
      ).id,
      await result()
    );
    await expect(releaseCoocSnapshot(sql, contentHash, { dryRun: false })).rejects.toThrow(
      /only study/
    );
    expect((await ids(db)).length).toBe(1);
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
