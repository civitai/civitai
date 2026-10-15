import { readFileSync } from 'fs';
import { join } from 'path';
import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import {
  selectCoocSnapshotsToDelete,
  type CoocSql,
} from '~/server/services/resource-intent-cooc/store';
import {
  applyTagIndexRetention,
  beginTagIndexBuild,
  completeTagIndexBuild,
  failTagIndexBuild,
  latestReadyTagIndexSnapshotId,
  loadTagIndexSnapshot,
  releaseTagIndexSnapshot,
  tagIndexContentHash,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
  TagIndexRetentionOverdueError,
  TagIndexSnapshotCorruptError,
  TagIndexSnapshotExpiredError,
  TagIndexSnapshotHashMismatchError,
  TagIndexSnapshotKindMismatchError,
  TagIndexStudyDuplicateError,
  type TagIndexBuildResult,
} from '~/server/services/resource-intent-tags/store';
import { asFixtureWriter } from './resource-intent-cooc.harness';
import {
  freshTagDb,
  seedTagIndex as seed,
  TAGS_MIGRATION_SQL,
  tagIndexIds as ids,
  VOCAB,
  vocabularyPayload,
} from './resource-intent-tags.harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const NOW = new Date('2026-10-15T12:00:00Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);
const ahead = (d: number) => new Date(NOW.getTime() + d * DAY);

const PAYLOAD = Buffer.from(JSON.stringify({ postings: [3, 1, 2] }));
const decodeJson = (p: Uint8Array) => JSON.parse(Buffer.from(p).toString('utf8'));

function result(payload: Buffer = PAYLOAD): TagIndexBuildResult {
  return {
    payload,
    trainImageIds: Buffer.from([3, 1, 2]),
    trainCreatedAtMin: ago(100),
    trainCreatedAtMax: ago(11),
    idsTried: 10,
    trainRows: 7,
    vocab: 2,
    models: 3,
    keptPairs: 4,
  };
}
const begin = (
  sql: CoocSql,
  kind: 'production' | 'study',
  over: Partial<{ trainEnd: Date; pinnedUntil: Date | null; vocabVersion: string }> = {}
) =>
  beginTagIndexBuild(sql, {
    kind,
    specHash: 'spec',
    vocabVersion: over.vocabVersion ?? VOCAB.vocabVersion,
    trainStart: ago(100),
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

describe('tag index store on the real migration', () => {
  it('the migration is re-runnable', async () => {
    const { db } = await freshTagDb();
    await expect(db.exec(TAGS_MIGRATION_SQL)).resolves.toBeDefined();
  });

  it('round-trips a ready build, verifies its content hash and carries its vocabulary version', async () => {
    const { sql } = await freshTagDb();
    const { id } = await begin(sql, 'production');
    const r = result();
    const { contentHash, created } = await completeTagIndexBuild(sql, id, r);
    expect(created).toBe(true);
    expect(contentHash).toBe(tagIndexContentHash('production', VOCAB.vocabVersion, r.payload));
    expect(await latestReadyTagIndexSnapshotId(sql)).toBe(contentHash);
    const loaded = await loadTagIndexSnapshot(sql, contentHash, {
      kind: 'production',
      now: NOW,
      decode: decodeJson,
    });
    expect(loaded.payload).toEqual({ postings: [3, 1, 2] });
    expect(loaded.meta).toMatchObject({
      status: 'ready',
      kind: 'production',
      vocabVersion: VOCAB.vocabVersion,
      idsTried: 10,
      trainRows: 7,
      vocab: 2,
      models: 3,
      keptPairs: 4,
      trainCreatedAtMin: ago(100),
      trainCreatedAtMax: ago(11),
    });
  });

  it('a build must name a vocabulary that exists, in the store and by the foreign key', async () => {
    const { db, sql } = await freshTagDb();
    await expect(begin(sql, 'study', { vocabVersion: 'f'.repeat(64) })).rejects.toThrow(
      /does not exist/
    );
    await expect(
      db.query(
        `INSERT INTO "ResourceIntentTagIndexSnapshot" ("kind","specHash","vocabVersion","trainStart","trainEnd","seed")
         VALUES ('production','s', $1, now(), now(), 1)`,
        ['f'.repeat(64)]
      )
    ).rejects.toThrow(/vocabVersion_fkey/);
  });

  it('a production build needs a frozen vocabulary; a study may use a candidate', async () => {
    const { db, sql } = await freshTagDb();
    const candidate = vocabularyPayload('candidate');
    await db.query(
      `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary") VALUES ($1, $2, '{}')`,
      [candidate.vocabVersion, candidate.payload]
    );
    await expect(
      begin(sql, 'production', { vocabVersion: candidate.vocabVersion })
    ).rejects.toThrow(/is not frozen/);
    await expect(
      begin(sql, 'study', { vocabVersion: candidate.vocabVersion })
    ).resolves.toBeDefined();
    await db.query(
      `UPDATE "ResourceIntentVocabulary" SET "status" = 'retired' WHERE "vocabVersion" = $1`,
      [VOCAB.vocabVersion]
    );
    await expect(begin(sql, 'production')).rejects.toThrow(/is not frozen/);
    expect(await ids(db)).toHaveLength(1);
  });

  it('the same payload under another vocabulary is a distinct snapshot, not a duplicate', async () => {
    const { db, sql } = await freshTagDb();
    const other = vocabularyPayload('other');
    await db.query(
      `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary") VALUES ($1, $2, '{}')`,
      [other.vocabVersion, other.payload]
    );
    await db.query(
      `UPDATE "ResourceIntentVocabulary" SET "status" = 'frozen', "frozenBy" = 'fixture' WHERE "vocabVersion" = $1`,
      [other.vocabVersion]
    );
    const a = await completeTagIndexBuild(sql, (await begin(sql, 'production')).id, result());
    const b = await completeTagIndexBuild(
      sql,
      (
        await begin(sql, 'production', { vocabVersion: other.vocabVersion })
      ).id,
      result()
    );
    expect([a.created, b.created]).toEqual([true, true]);
    expect(b.contentHash).not.toBe(a.contentHash);
    expect(b.contentHash).toBe(tagIndexContentHash('production', other.vocabVersion, PAYLOAD));
  });

  it('missing rows are reported, not silently ignored', async () => {
    const { sql } = await freshTagDb();
    await expect(completeTagIndexBuild(sql, 'nope', result())).rejects.toThrow(/not found/);
    const opts = { kind: 'production' as const, now: NOW, decode: decodeJson };
    await expect(loadTagIndexSnapshot(sql, 'nope', opts)).rejects.toThrow(/not found/);
    await expect(releaseTagIndexSnapshot(sql, 'nope', { dryRun: true })).rejects.toThrow(
      /not found/
    );
  });

  it('refuses a payload above the size ceiling', async () => {
    const { sql } = await freshTagDb();
    const { id } = await begin(sql, 'production');
    await expect(
      completeTagIndexBuild(sql, id, result(Buffer.alloc(TAG_INDEX_MAX_PAYLOAD_BYTES + 1)))
    ).rejects.toThrow(/exceeds/);
  });

  it('refuses a payload whose bytes no longer match the content hash', async () => {
    const { db, sql } = await freshTagDb();
    const { id } = await begin(sql, 'production');
    const { contentHash } = await completeTagIndexBuild(sql, id, result());
    await asFixtureWriter(db, () =>
      db.query(
        `UPDATE "ResourceIntentTagIndexSnapshot" SET "payload" = "payload" || '\\x00'::bytea WHERE "id" = $1`,
        [id]
      )
    );
    await expect(
      loadTagIndexSnapshot(sql, contentHash, { kind: 'production', now: NOW, decode: decodeJson })
    ).rejects.toBeInstanceOf(TagIndexSnapshotHashMismatchError);
  });

  it('a ready study build and a ready production build of the same data have distinct content hashes', async () => {
    const { sql } = await freshTagDb();
    const prod = await completeTagIndexBuild(sql, (await begin(sql, 'production')).id, result());
    const study = await completeTagIndexBuild(sql, (await begin(sql, 'study')).id, result());
    expect(prod.created && study.created).toBe(true);
    expect(study.contentHash).not.toBe(prod.contentHash);
  });

  it('the same content twice under one kind keeps one ready row; the second is a duplicate', async () => {
    const { db, sql } = await freshTagDb();
    const a = await completeTagIndexBuild(sql, (await begin(sql, 'production')).id, result());
    const b = await completeTagIndexBuild(sql, (await begin(sql, 'production')).id, result());
    expect([a.created, b.created]).toEqual([true, false]);
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "status"`
    );
    expect(st.rows.map((x) => x.status)).toEqual(['duplicate', 'ready']);
  });

  it('a second study build of the same content fails loudly instead of sharing the first pin', async () => {
    const { db, sql } = await freshTagDb();
    const first = await completeTagIndexBuild(sql, (await begin(sql, 'study')).id, result());
    const second = (await begin(sql, 'study', { pinnedUntil: new Date(Date.now() + 50 * DAY) })).id;
    await expect(completeTagIndexBuild(sql, second, result())).rejects.toBeInstanceOf(
      TagIndexStudyDuplicateError
    );
    const st = await db.query<{ id: string; status: string; contentHash: string | null }>(
      `SELECT "id", "status", "contentHash" FROM "ResourceIntentTagIndexSnapshot"`
    );
    expect(st.rows.find((x) => x.id === second)?.status).toBe('duplicate');
    expect(st.rows.filter((x) => x.status === 'ready').map((x) => x.contentHash)).toEqual([
      first.contentHash,
    ]);
  });

  it('a concurrent identical build that wins the unique index makes this one a duplicate', async () => {
    const { db, sql } = await freshTagDb();
    await completeTagIndexBuild(sql, (await begin(sql, 'production')).id, result());
    const { id } = await begin(sql, 'production');
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
    expect(await completeTagIndexBuild(racing, id, result())).toMatchObject({ created: false });
    expect(hidden).toBe(false);
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentTagIndexSnapshot" ORDER BY "status"`
    );
    expect(st.rows.map((x) => x.status)).toEqual(['duplicate', 'ready']);
  });

  it('a failed build is recorded and cannot later be completed', async () => {
    const { db, sql } = await freshTagDb();
    const a = await begin(sql, 'production');
    await failTagIndexBuild(sql, a.id);
    await expect(completeTagIndexBuild(sql, a.id, result())).rejects.toThrow(/is 'failed'/);
    const rows = await db.query<{ status: string; contentHash: string | null }>(
      `SELECT "status", "contentHash" FROM "ResourceIntentTagIndexSnapshot"`
    );
    expect(rows.rows).toEqual([{ status: 'failed', contentHash: null }]);
  });

  it('never writes builtAt: the database sets it, and a supplied one is refused', async () => {
    const { db, sql, statements } = await freshTagDb();
    const { id, builtAt } = await beginTagIndexBuild(sql, {
      kind: 'production',
      specHash: 's',
      vocabVersion: VOCAB.vocabVersion,
      trainStart: ago(100),
      trainEnd: ago(10),
      seed: 1,
      pinnedUntil: null,
      now: new Date('2020-01-01T00:00:00Z'),
    });
    const [{ dbNow }] = (await db.query<{ dbNow: Date }>(`SELECT now()::timestamp(3) AS "dbNow"`))
      .rows;
    expect(Math.abs(builtAt.getTime() - dbNow.getTime())).toBeLessThan(60_000);
    const insert = statements.find((s) => s.includes('INSERT')) as string;
    expect(insert.split('RETURNING')[0]).not.toContain('"builtAt"');
    await completeTagIndexBuild(sql, id, result());
    expect(statements.filter((s) => /UPDATE[\s\S]*"builtAt"/.test(s))).toEqual([]);
    const stored = await db.query<{ builtAt: Date }>(
      `SELECT "builtAt" FROM "ResourceIntentTagIndexSnapshot"`
    );
    expect(stored.rows[0].builtAt.getTime()).toBe(builtAt.getTime());
    await expect(
      beginTagIndexBuild(sql, {
        kind: 'production',
        specHash: 's',
        vocabVersion: VOCAB.vocabVersion,
        trainStart: ago(100),
        trainEnd: ago(10),
        seed: 1,
        pinnedUntil: null,
        now: NOW,
        builtAt: NOW,
      } as never)
    ).rejects.toThrow(/builtAt is set by the database/);
  });
});

describe('tag index row guard trigger', () => {
  it('overwrites a writer-supplied builtAt with the database clock', async () => {
    const { db } = await freshTagDb();
    await db.query(
      `INSERT INTO "ResourceIntentTagIndexSnapshot" ("kind","specHash","vocabVersion","trainStart","trainEnd","seed","builtAt")
       VALUES ('production','s', $1, now() - interval '100 days', now() - interval '10 days', 1, '2001-01-01')`,
      [VOCAB.vocabVersion]
    );
    const r = await db.query<{ off: number }>(
      `SELECT abs(extract(epoch FROM (now()::timestamp(3) - "builtAt"))) AS "off" FROM "ResourceIntentTagIndexSnapshot"`
    );
    expect(Number(r.rows[0].off)).toBeLessThan(60);
  });

  it('refuses any change to a ready row, and any change of builtAt', async () => {
    const { db, sql } = await freshTagDb();
    const { id } = await begin(sql, 'production');
    await expect(
      db.query(
        `UPDATE "ResourceIntentTagIndexSnapshot" SET "builtAt" = '2001-01-01' WHERE "id" = $1`,
        [id]
      )
    ).rejects.toThrow(/builtAt cannot change/);
    await completeTagIndexBuild(sql, id, result());
    await expect(
      db.query(
        `UPDATE "ResourceIntentTagIndexSnapshot" SET "vocabVersion" = "vocabVersion" WHERE "id" = $1`,
        [id]
      )
    ).rejects.toThrow(/only a building row can change/);
    await expect(failTagIndexBuild(sql, id)).resolves.toBeUndefined();
    const st = await db.query<{ status: string }>(
      `SELECT "status" FROM "ResourceIntentTagIndexSnapshot"`
    );
    expect(st.rows[0].status).toBe('ready');
  });
});

describe('tag index pin rules (store and CHECK)', () => {
  const insertRaw = (db: PGlite, kind: string, pin: string | null) =>
    db.query(
      `INSERT INTO "ResourceIntentTagIndexSnapshot" ("kind","specHash","vocabVersion","trainStart","trainEnd","seed","pinnedUntil")
       VALUES ($1, 's', $2, now() - interval '100 days', now() - interval '10 days', 1, ${
         pin ?? 'NULL'
       })`,
      [kind, VOCAB.vocabVersion]
    );

  it('a study row without a pin is rejected by the store and by the CHECK', async () => {
    const { db, sql } = await freshTagDb();
    await expect(begin(sql, 'study', { pinnedUntil: null })).rejects.toThrow(/requires a pin/);
    await expect(insertRaw(db, 'study', null)).rejects.toThrow(/kind_pin_check/);
    expect(await ids(db)).toEqual([]);
  });

  it('a pin beyond 58 days is rejected by the store and by the CHECK; 58 is accepted', async () => {
    const { db, sql } = await freshTagDb();
    await expect(insertRaw(db, 'study', `now() + interval '59 days'`)).rejects.toThrow(
      /kind_pin_check/
    );
    await expect(insertRaw(db, 'study', `now() + interval '58 days'`)).resolves.toBeDefined();
    await expect(
      begin(sql, 'study', { pinnedUntil: new Date(Date.now() + 59 * DAY) })
    ).rejects.toThrow(/58 days/);
  });

  it('a study pin at or before the build is rejected by the CHECK', async () => {
    const { db } = await freshTagDb();
    await expect(insertRaw(db, 'study', 'now()')).rejects.toThrow(/kind_pin_check/);
    await expect(insertRaw(db, 'study', `now() + interval '1 second'`)).resolves.toBeDefined();
  });

  it('a production row with a pin is rejected by the store and by the CHECK', async () => {
    const { db, sql } = await freshTagDb();
    await expect(begin(sql, 'production', { pinnedUntil: ahead(5) })).rejects.toThrow(
      /cannot be pinned/
    );
    await expect(insertRaw(db, 'production', `now() + interval '5 days'`)).rejects.toThrow(
      /kind_pin_check/
    );
  });

  it('a ready row must carry its hash and payload (CHECK)', async () => {
    const { db } = await freshTagDb();
    await expect(
      db.query(
        `INSERT INTO "ResourceIntentTagIndexSnapshot" ("kind","status","specHash","vocabVersion","trainStart","trainEnd","seed")
         VALUES ('production','ready','s', $1, now(), now(), 1)`,
        [VOCAB.vocabVersion]
      )
    ).rejects.toThrow(/ready_check/);
  });
});

describe('tag index loader', () => {
  it('refuses an expired study snapshot even before retention runs', async () => {
    const { sql } = await freshTagDb();
    const pin = new Date(Date.now() + 2 * DAY);
    const { contentHash } = await completeTagIndexBuild(
      sql,
      (
        await begin(sql, 'study', { pinnedUntil: pin })
      ).id,
      result()
    );
    const opts = { kind: 'study' as const, decode: decodeJson };
    await expect(
      loadTagIndexSnapshot(sql, contentHash, { ...opts, now: new Date(pin.getTime() - 1) })
    ).resolves.toBeDefined();
    await expect(
      loadTagIndexSnapshot(sql, contentHash, { ...opts, now: pin })
    ).rejects.toBeInstanceOf(TagIndexSnapshotExpiredError);
  });

  it('a study pinned to a production hash is refused, not served (and vice versa)', async () => {
    const { sql } = await freshTagDb();
    const prod = await completeTagIndexBuild(sql, (await begin(sql, 'production')).id, result());
    const study = await completeTagIndexBuild(sql, (await begin(sql, 'study')).id, result());
    await expect(
      loadTagIndexSnapshot(sql, prod.contentHash, { kind: 'study', now: NOW, decode: decodeJson })
    ).rejects.toBeInstanceOf(TagIndexSnapshotKindMismatchError);
    await expect(
      loadTagIndexSnapshot(sql, study.contentHash, {
        kind: 'production',
        now: NOW,
        decode: decodeJson,
      })
    ).rejects.toBeInstanceOf(TagIndexSnapshotKindMismatchError);
  });

  it('a payload the decoder rejects is corrupt; an allocation failure is rethrown as it is', async () => {
    const { sql } = await freshTagDb();
    const { contentHash } = await completeTagIndexBuild(
      sql,
      (
        await begin(sql, 'production')
      ).id,
      result(Buffer.from('not json'))
    );
    const load = (decode: (p: Uint8Array) => unknown) =>
      loadTagIndexSnapshot(sql, contentHash, { kind: 'production', now: NOW, decode });
    await expect(load(decodeJson)).rejects.toBeInstanceOf(TagIndexSnapshotCorruptError);
    const oom = new RangeError('Array buffer allocation failed');
    await expect(
      load(() => {
        throw oom;
      })
    ).rejects.toBe(oom);
  });
});

describe('tag index served snapshot', () => {
  it('a study snapshot built later is never returned as latest', async () => {
    const { db, sql } = await freshTagDb();
    await seed(db, { kind: 'production', trainEnd: ago(9), builtAt: ago(8), contentHash: 'P' });
    await seed(db, {
      kind: 'study',
      trainEnd: ago(1),
      builtAt: ago(0.5),
      pinnedUntil: ahead(10),
      contentHash: 'S',
    });
    expect(await latestReadyTagIndexSnapshotId(sql)).toBe('P');
  });

  it('a later-built production snapshot with an older trainEnd does not displace the served one', async () => {
    const { db, sql } = await freshTagDb();
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
    expect(await latestReadyTagIndexSnapshotId(sql)).toBe('SERVED');
    await seed(db, {
      kind: 'production',
      trainEnd: ago(9),
      builtAt: ago(1),
      contentHash: 'REBUILT',
    });
    expect(await latestReadyTagIndexSnapshotId(sql)).toBe('REBUILT');
  });

  it('a newer failed or building row is never served', async () => {
    const { db, sql } = await freshTagDb();
    await seed(db, { kind: 'production', trainEnd: ago(9), builtAt: ago(8), contentHash: 'P' });
    await seed(db, { kind: 'production', status: 'failed', trainEnd: ago(1), builtAt: ago(0.5) });
    await seed(db, { kind: 'production', status: 'building', trainEnd: ago(1), builtAt: ago(0.1) });
    expect(await latestReadyTagIndexSnapshotId(sql)).toBe('P');
  });

  it('a full tie on trainEnd and builtAt is broken by the higher id, in SQL and in retention alike', async () => {
    const { db, sql } = await freshTagDb();
    const t = ago(9);
    const b = ago(8);
    await seed(db, { id: 'aaa', kind: 'production', trainEnd: t, builtAt: b, contentHash: 'A' });
    await seed(db, { id: 'zzz', kind: 'production', trainEnd: t, builtAt: b, contentHash: 'Z' });
    expect(await latestReadyTagIndexSnapshotId(sql)).toBe('Z');
    const rows = (
      await db.query<Parameters<typeof selectCoocSnapshotsToDelete>[0][number]>(
        `SELECT "id","kind","status","trainEnd","builtAt","pinnedUntil" FROM "ResourceIntentTagIndexSnapshot"`
      )
    ).rows;
    expect(selectCoocSnapshotsToDelete(rows, ahead(400))).toEqual(['aaa']);
    expect((await applyTagIndexRetention(sql, ahead(400))).deleted).toEqual(['aaa']);
  });

  it('retention protects exactly the row latestReadyTagIndexSnapshotId serves (random tables)', async () => {
    let x = 5;
    const rnd = () => (x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const { db, sql } = await freshTagDb();
    for (let trial = 0; trial < 25; trial++) {
      await db.exec(`DELETE FROM "ResourceIntentTagIndexSnapshot"`);
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
          trainEnd: ago(10 * Math.floor(rnd() * 4) + 2),
          builtAt,
          pinnedUntil: kind === 'study' ? new Date(builtAt.getTime() + 10 * DAY) : null,
          contentHash: hash,
        });
        hashToId.set(hash, id);
      }
      const served = await latestReadyTagIndexSnapshotId(sql);
      await applyTagIndexRetention(sql, ahead(400)).catch((e) => {
        if (!(e instanceof TagIndexRetentionOverdueError)) throw e;
      });
      expect(await ids(db)).toEqual(served ? [hashToId.get(served)] : []);
    }
  });
});

describe('tag index retention', () => {
  it('deletes a 5-week-old production snapshot, keeps a 3-week-old one and the served one', async () => {
    const { db, sql } = await freshTagDb();
    const served = await seed(db, { kind: 'production', trainEnd: ago(2), builtAt: ago(1) });
    const recent = await seed(db, { kind: 'production', trainEnd: ago(22), builtAt: ago(21) });
    const old = await seed(db, { kind: 'production', trainEnd: ago(36), builtAt: ago(35) });
    const { deleted } = await applyTagIndexRetention(sql, NOW);
    expect(deleted).toEqual([old]);
    expect((await ids(db)).sort()).toEqual([served, recent].sort());
  });

  it('keeps the served production snapshot however old it is', async () => {
    const { db, sql } = await freshTagDb();
    const served = await seed(db, { kind: 'production', trainEnd: ago(91), builtAt: ago(90) });
    await applyTagIndexRetention(sql, NOW);
    expect(await ids(db)).toEqual([served]);
  });

  it('a pinned study survives until its pin, and goes on the sweep at the pin', async () => {
    const { db, sql } = await freshTagDb();
    const pin = ahead(3);
    const study = await seed(db, {
      kind: 'study',
      trainEnd: ago(30),
      builtAt: ago(40),
      pinnedUntil: pin,
    });
    await applyTagIndexRetention(sql, new Date(pin.getTime() - 1));
    expect(await ids(db)).toEqual([study]);
    expect((await applyTagIndexRetention(sql, pin)).deleted).toEqual([study]);
  });

  it('deletes non-ready rows after 7 days, not before', async () => {
    const { db, sql } = await freshTagDb();
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
    const { deleted } = await applyTagIndexRetention(sql, NOW);
    expect(deleted).toEqual([eight]);
    expect(await ids(db)).toEqual([six]);
  });

  it('a sweep that leaves an overdue study row throws, a row pinned to exactly now included', async () => {
    const { db, sql } = await freshTagDb();
    await seed(db, { kind: 'study', trainEnd: ago(30), builtAt: ago(40), pinnedUntil: NOW });
    const deafToDeletes: CoocSql = {
      query: sql.query,
      execute: async (s) => (s.text.startsWith('DELETE') ? 0 : sql.execute(s)),
    };
    await expect(applyTagIndexRetention(deafToDeletes, NOW)).rejects.toBeInstanceOf(
      TagIndexRetentionOverdueError
    );
  });

  it('a missing table is not an error', async () => {
    const { db, sql } = await freshTagDb();
    await db.exec('DROP TABLE "ResourceIntentTagIndexSnapshot"');
    expect(await applyTagIndexRetention(sql, NOW)).toEqual({ deleted: [], tableMissing: true });
  });
});

describe('tag index release', () => {
  it('deletes a study snapshot immediately; a dry run deletes nothing', async () => {
    const { db, sql } = await freshTagDb();
    const { contentHash } = await completeTagIndexBuild(
      sql,
      (
        await begin(sql, 'study')
      ).id,
      result()
    );
    const dry = await releaseTagIndexSnapshot(sql, contentHash, { dryRun: true });
    expect(dry.deleted).toBe(false);
    expect((await ids(db)).length).toBe(1);
    expect(await releaseTagIndexSnapshot(sql, contentHash, { dryRun: false })).toEqual({
      id: dry.id,
      deleted: true,
    });
    expect(await ids(db)).toEqual([]);
  });

  it('refuses a production snapshot', async () => {
    const { db, sql } = await freshTagDb();
    const { contentHash } = await completeTagIndexBuild(
      sql,
      (
        await begin(sql, 'production')
      ).id,
      result()
    );
    await expect(releaseTagIndexSnapshot(sql, contentHash, { dryRun: false })).rejects.toThrow(
      /only study/
    );
    expect((await ids(db)).length).toBe(1);
  });
});

describe('ResourceIntentVocabulary rules (CHECKs and trigger)', () => {
  const insert = (db: PGlite, v: { vocabVersion: string; payload: Buffer }, status?: string) =>
    db.query(
      `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary"${
        status ? ', "status"' : ''
      }) VALUES ($1, $2, '{"rules": 1}'${status ? ', $3' : ''}) RETURNING "createdAt"`,
      status ? [v.vocabVersion, v.payload, status] : [v.vocabVersion, v.payload]
    );
  const setStatus = (db: PGlite, v: string, status: string, frozenBy: string | null = null) =>
    db.query(
      `UPDATE "ResourceIntentVocabulary" SET "status" = $2, "frozenBy" = COALESCE($3, "frozenBy") WHERE "vocabVersion" = $1`,
      [v, status, frozenBy]
    );
  const row = async (db: PGlite, v: string) =>
    (
      await db.query<{ status: string; frozenAt: Date | null; frozenBy: string | null }>(
        `SELECT "status", "frozenAt", "frozenBy" FROM "ResourceIntentVocabulary" WHERE "vocabVersion" = $1`,
        [v]
      )
    ).rows[0];

  it('the version must be the sha256 of the payload, and is unique', async () => {
    const { db } = await freshTagDb();
    const v = vocabularyPayload('other');
    await expect(insert(db, { ...v, vocabVersion: VOCAB.vocabVersion })).rejects.toThrow(
      /version_check|vocabVersion_key/
    );
    await expect(insert(db, { ...v, vocabVersion: 'a'.repeat(64) })).rejects.toThrow(
      /version_check/
    );
    await expect(insert(db, VOCAB)).rejects.toThrow(/vocabVersion_key/);
    await expect(insert(db, v)).resolves.toBeDefined();
  });

  it('is inserted as a candidate, with the database clock as createdAt', async () => {
    const { db } = await freshTagDb();
    const v = vocabularyPayload('other');
    await expect(insert(db, v, 'frozen')).rejects.toThrow(/inserted as candidate/);
    await expect(insert(db, v, 'retired')).rejects.toThrow(/inserted as candidate/);
    await db.query(
      `INSERT INTO "ResourceIntentVocabulary" ("vocabVersion", "payload", "rulesSummary", "createdAt") VALUES ($1, $2, '{}', '2001-01-01')`,
      [v.vocabVersion, v.payload]
    );
    const r = await db.query<{ off: number }>(
      `SELECT abs(extract(epoch FROM (now()::timestamp(3) - "createdAt"))) AS "off" FROM "ResourceIntentVocabulary" WHERE "vocabVersion" = $1`,
      [v.vocabVersion]
    );
    expect(Number(r.rows[0].off)).toBeLessThan(60);
  });

  it('freezing needs frozenBy and stamps frozenAt itself', async () => {
    const { db } = await freshTagDb();
    const v = vocabularyPayload('other');
    await insert(db, v);
    await expect(setStatus(db, v.vocabVersion, 'frozen')).rejects.toThrow(/status_check/);
    await db.query(
      `UPDATE "ResourceIntentVocabulary" SET "status" = 'frozen', "frozenBy" = 'operator', "frozenAt" = '2001-01-01' WHERE "vocabVersion" = $1`,
      [v.vocabVersion]
    );
    const r = await row(db, v.vocabVersion);
    expect(r.status).toBe('frozen');
    expect(r.frozenBy).toBe('operator');
    expect(Math.abs((r.frozenAt as Date).getTime() - Date.now())).toBeLessThan(3_600_000);
  });

  it('allows only candidate -> frozen -> retired and candidate -> retired', async () => {
    const { db } = await freshTagDb();
    const a = vocabularyPayload('a');
    await insert(db, a);
    const v = a.vocabVersion;
    await setStatus(db, v, 'frozen', 'operator');
    await expect(setStatus(db, v, 'candidate')).rejects.toThrow(/cannot become/);
    await setStatus(db, v, 'retired');
    await expect(setStatus(db, v, 'frozen')).rejects.toThrow(/cannot become/);
    await expect(setStatus(db, v, 'candidate')).rejects.toThrow(/cannot become/);
    expect((await row(db, v)).status).toBe('retired');
    const other = vocabularyPayload('other');
    await insert(db, other);
    await setStatus(db, other.vocabVersion, 'retired');
    expect(await row(db, other.vocabVersion)).toEqual({
      status: 'retired',
      frozenAt: null,
      frozenBy: null,
    });
  });

  it('every column but status is fixed, and frozenAt/frozenBy change only by freezing', async () => {
    const { db } = await freshTagDb();
    const a = vocabularyPayload('a');
    await insert(db, a);
    const swap = vocabularyPayload('swapped');
    const update = (set: string, params: unknown[] = []) =>
      db.query(`UPDATE "ResourceIntentVocabulary" SET ${set} WHERE "vocabVersion" = $1`, [
        a.vocabVersion,
        ...params,
      ]);
    // Payload and version together satisfy the sha256 CHECK, so only the trigger can refuse it.
    await expect(
      update(`"payload" = $2, "vocabVersion" = $3`, [swap.payload, swap.vocabVersion])
    ).rejects.toThrow(/only status can change/);
    await expect(update(`"rulesSummary" = '{"rules": 2}'`)).rejects.toThrow(
      /only status can change/
    );
    await expect(update(`"createdAt" = '2001-01-01'`)).rejects.toThrow(/only status can change/);
    await expect(update(`"id" = 'another-id'`)).rejects.toThrow(/only status can change/);
    await expect(update(`"frozenBy" = 'early'`)).rejects.toThrow(/set only by freezing/);
    await setStatus(db, a.vocabVersion, 'frozen', 'operator');
    await expect(update(`"frozenBy" = 'someone else'`)).rejects.toThrow(/set only by freezing/);
    await expect(update(`"frozenAt" = '2001-01-01'`)).rejects.toThrow(/set only by freezing/);
  });

  it('a vocabulary an index was built from cannot be deleted', async () => {
    const { db, sql } = await freshTagDb();
    await begin(sql, 'production');
    await expect(
      db.query(`DELETE FROM "ResourceIntentVocabulary" WHERE "vocabVersion" = $1`, [
        VOCAB.vocabVersion,
      ])
    ).rejects.toThrow(/vocabVersion_fkey/);
  });
});

describe('ResourceIntentTagIndexSnapshot mirrors ResourceIntentCoocSnapshot', () => {
  const COOC_SQL = readFileSync(
    join(
      process.cwd(),
      'packages/civitai-db-schema/prisma/migrations/20261011120000_resource_intent_cooc_snapshot/migration.sql'
    ),
    'utf8'
  );

  it('column for column, plus vocabVersion; same CHECKs and indexes', async () => {
    const { db } = await freshTagDb({ extraSql: COOC_SQL });
    const columns = async (table: string) =>
      (
        await db.query<Record<string, string>>(
          `SELECT column_name, data_type, is_nullable, column_default, datetime_precision::text AS p
           FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
          [table]
        )
      ).rows;
    const cooc = await columns('ResourceIntentCoocSnapshot');
    const tags = await columns('ResourceIntentTagIndexSnapshot');
    expect(cooc.length).toBe(19);
    expect(tags.slice(0, cooc.length)).toEqual(cooc);
    expect(tags.slice(cooc.length)).toEqual([
      {
        column_name: 'vocabVersion',
        data_type: 'text',
        is_nullable: 'NO',
        column_default: null,
        p: null,
      },
    ]);
    const defs = async (table: string) => {
      const checks = await db.query<{ d: string }>(
        `SELECT conname || ' ' || pg_get_constraintdef(oid) AS d FROM pg_constraint
         WHERE conrelid = $1::regclass AND contype = 'c'`,
        [`"${table}"`]
      );
      const indexes = await db.query<{ d: string }>(
        `SELECT indexdef AS d FROM pg_indexes WHERE tablename = $1`,
        [table]
      );
      return [...checks.rows, ...indexes.rows].map((r) => r.d.replaceAll(table, '<T>')).sort();
    };
    const coocDefs = await defs('ResourceIntentCoocSnapshot');
    expect(coocDefs.length).toBe(5);
    expect(await defs('ResourceIntentTagIndexSnapshot')).toEqual(coocDefs);
  });

  it('the same row-guard trigger and function', async () => {
    const { db } = await freshTagDb({ extraSql: COOC_SQL });
    const guard = async (table: string) => {
      const fn = await db.query<{ d: string }>(`SELECT pg_get_functiondef($1::regproc) AS d`, [
        `"${table}_guard"`,
      ]);
      const triggers = await db.query<{ d: string }>(
        `SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger
         WHERE tgrelid = $1::regclass AND NOT tgisinternal`,
        [`"${table}"`]
      );
      return [...fn.rows, ...triggers.rows].map((r) => r.d.replaceAll(table, '<T>'));
    };
    const cooc = await guard('ResourceIntentCoocSnapshot');
    expect(cooc).toHaveLength(2);
    expect(cooc[0]).toContain('builtAt');
    expect(await guard('ResourceIntentTagIndexSnapshot')).toEqual(cooc);
  });
});
