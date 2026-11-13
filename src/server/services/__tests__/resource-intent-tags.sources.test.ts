import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { pgliteSql, utcPglite } from './resource-intent-cooc.harness';
import {
  COOC_ELIGIBLE_ATTACHMENTS,
  COOC_ELIGIBLE_IMAGE,
  COOC_ELIGIBLE_REST,
} from '~/server/services/resource-intent-cooc/build';
import {
  parseTagVocabulary,
  TagIndexAccumulator,
  type TagModelContent,
  type TagTrainingRow,
} from '~/server/services/resource-intent-tags/build';
import {
  assertObservationKey,
  CONTENT_IMAGE_ELIGIBLE,
  fetchVersionInfo,
  genObservationOf,
  genObservationsSql,
  genTrainingRow,
  observationKeyFingerprint,
  observationUserHash,
  CONTENT_READ_CONCURRENCY,
  MODEL_LISTED_SQL,
  ELIGIBLE_MODEL_PAGE,
  readEligibleModelIds,
  readModelContent,
  readPostedSample,
  retryingQuery,
  standbyQuery,
  tagTrainingWindow,
  unionAscending,
  type VersionInfo,
} from '~/server/services/resource-intent-tags/sources';

describe('resource-intent-tags sources', () => {
  // Vectors produced by RUNNING the observations' writer (its own `user_hash` and `key_fingerprint`)
  // on this test key, not by re-deriving its formula.
  const testKey = Buffer.from(
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
    'hex'
  );

  it.each([
    [1, '12767728711029640056'],
    [4823917, '17611710126099704230'],
    [2 ** 31, '11339119219866617676'],
    [Number.MAX_SAFE_INTEGER, '11768557503457933977'],
  ])("hashes posted user %i exactly as the observations' writer does", (id, expected) => {
    expect(observationUserHash(testKey, id)).toBe(expected);
  });

  it.each([1.5, 2 ** 53])('refuses user id %s, which is not a safe integer', (id) => {
    expect(() => observationUserHash(testKey, id)).toThrow('is not an integer');
  });

  it("fingerprints a key exactly as the observations' writer does", () => {
    expect(observationKeyFingerprint(testKey)).toBe('cef65755129e1225');
  });

  it('refuses a hash key whose fingerprint is not the expected one', () => {
    expect(() => assertObservationKey(testKey, 'cef65755129e1225')).not.toThrow();
    const other = Buffer.from(testKey);
    other[0] ^= 1;
    expect(() => assertObservationKey(other, 'cef65755129e1225')).toThrow('refusing to hash');
    expect(() => assertObservationKey(testKey, '')).toThrow('16 lowercase hex');
    expect(() => assertObservationKey(Buffer.alloc(0), 'cef65755129e1225')).toThrow('empty');
  });

  it('maps an observation, skipping versions the map does not know', () => {
    const o = genObservationOf({
      u: '77',
      p: 'a kite',
      v: ['5', 6, 9],
      liked: 1,
      favorite: 0,
      disliked: '0',
    });
    expect(o).toEqual({
      user: '77',
      prompt: 'a kite',
      versionIds: [5, 6, 9],
      liked: true,
      favorite: false,
      disliked: false,
    });
    const versions = new Map([
      [5, { modelId: 50, type: 'Checkpoint', baseModel: 'E1', flagged: false }],
      [9, { modelId: 90, type: 'LORA', baseModel: 'E1', flagged: false }],
    ]);
    expect(genTrainingRow(o, versions)?.resources).toEqual([
      { modelId: 50, type: 'Checkpoint', baseModel: 'E1' },
      { modelId: 90, type: 'LORA', baseModel: 'E1' },
    ]);
    // A POI- or minor-flagged model anywhere in the observation drops it, as for a posted image.
    versions.set(6, { modelId: 60, type: 'LORA', baseModel: 'E1', flagged: true });
    expect(genTrainingRow(o, versions)).toBeNull();
  });

  it('reads version flags, and excludes deleted accounts from the observations', async () => {
    const seen: string[] = [];
    const query = async (q: Prisma.Sql) => {
      seen.push(q.sql);
      return [{ id: 6, modelId: 60, type: 'LORA', baseModel: 'E1', flagged: true }];
    };
    expect([...(await fetchVersionInfo(query, [6]))]).toEqual([
      [6, { modelId: 60, type: 'LORA', baseModel: 'E1', flagged: true }],
    ]);
    expect(seen[0]).toContain('(m.poi OR m.minor) AS flagged');
    const sql = genObservationsSql(new Date('2026-09-01'), new Date('2026-10-01'), 2);
    expect(sql).toContain('userHash NOT IN (SELECT userHash FROM p2m_restricted.deletedUsers)');
  });

  it("reads only unflagged models' content, and no Private or Unsearchable post", async () => {
    const seen: Prisma.Sql[] = [];
    const query = async (q: Prisma.Sql) => {
      seen.push(q);
      return q.sql.includes('"TagsOnModels"')
        ? [
            {
              id: 4,
              name: 'n',
              type: 'LORA',
              description: 'd',
              tags: ['t'],
              versions: [
                { baseModel: 'E1', trainedWords: ['w'] },
                { baseModel: null, trainedWords: null },
              ],
            },
          ]
        : [
            { modelId: 4, showcase: true, prompt: 's' },
            { modelId: 4, showcase: false, prompt: 'g' },
          ];
    };
    const got: TagModelContent[] = [];
    await readModelContent(query, [4], new Date('2026-10-01'), (m) => void got.push(...m));
    expect(got).toEqual([
      {
        modelId: 4,
        type: 'LORA',
        name: 'n',
        description: 'd',
        tags: ['t'],
        trigger: ['w'],
        baseModels: ['E1'],
        showcase: ['s'],
        gallery: ['g'],
      },
    ]);
    expect(seen[0].sql).toContain('AND NOT m.poi AND NOT m.minor');
    const hidden = `p.availability NOT IN ('Private'::"Availability", 'Unsearchable'::"Availability")`;
    expect(seen[1].sql.split(hidden).length - 1).toBe(2);
    expect(seen[1].sql.split(CONTENT_IMAGE_ELIGIBLE.sql).length - 1).toBe(2);
  });

  it('pins the content-image moderation predicate whole, flagged attachments included', () => {
    // Each clause is a moderation rule a reword could drop; the co-occurrence index's image and
    // attachment conditions, so the two indexes' inputs move together.
    expect(CONTENT_IMAGE_ELIGIBLE.sql).toBe(COOC_ELIGIBLE_IMAGE + COOC_ELIGIBLE_ATTACHMENTS);
    expect(CONTENT_IMAGE_ELIGIBLE.sql.replace(/\s+/g, ' ').trim()).toBe(
      `AND i."hideMeta" = false AND length(i.meta->>'prompt') > 0 AND i.ingestion = 'Scanned' ` +
        `AND i."tosViolation" = false AND i."needsReview" IS NULL AND i."blockedFor" IS NULL ` +
        `AND i.minor = false AND i.poi = false AND NOT EXISTS ( SELECT 1 FROM "ImageResourceNew" fr ` +
        `JOIN "ModelVersion" fmv ON fmv.id = fr."modelVersionId" JOIN "Model" fm ON fm.id = fmv."modelId" ` +
        `WHERE fr."imageId" = i.id AND (fm.poi OR fm.minor) )`
    );
  });

  it('samples each hour by its first minutes, inside the window', () => {
    const sql = genObservationsSql(
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-10-01T00:00:00Z'),
      2
    );
    expect(sql).toContain("time >= toDateTime('2026-09-01 00:00:00', 'UTC')");
    expect(sql).toContain("time < toDateTime('2026-10-01 00:00:00', 'UTC')");
    expect(sql.match(/toMinute\(toTimeZone\(time, 'UTC'\)\) < 2/g)?.length).toBe(2);
    expect(() => genObservationsSql(new Date(), new Date(), 0)).toThrow('sliceMinutes');
    expect(sql).not.toContain('LIMIT');
    const limited = genObservationsSql(new Date('2026-09-01'), new Date('2026-10-01'), 2, 500);
    expect(limited.trimEnd().endsWith('LIMIT 500')).toBe(true);
    for (const bad of [0, -1, 1.5, NaN])
      expect(() => genObservationsSql(new Date(), new Date(), 2, bad)).toThrow('positive integer');
  });

  it('ends the window a whole UTC day before the build day', () => {
    expect(tagTrainingWindow(new Date('2026-10-16T23:59:00Z'))).toEqual({
      start: new Date('2026-07-17T00:00:00Z'),
      end: new Date('2026-10-15T00:00:00Z'),
    });
  });

  it('reads nothing from a server that is not a standby, inside a read-only transaction', async () => {
    const run = (standby: boolean, log: string[]) =>
      standbyQuery(
        (fn) =>
          fn({
            $executeRawUnsafe: async (q: string) => (log.push(q), 0),
            $queryRaw: async <T>(q: Prisma.Sql) => {
              log.push(q.sql);
              return (q.sql.includes('pg_is_in_recovery') ? [{ standby }] : [{ id: 1 }]) as T;
            },
          }),
        1000
      );
    const primaryLog: string[] = [];
    await expect(run(false, primaryLog)({ sql: 'SELECT 1' } as Prisma.Sql)).rejects.toThrow(
      'not to a standby'
    );
    expect(primaryLog).not.toContain('SELECT 1');
    const log: string[] = [];
    await expect(run(true, log)({ sql: 'SELECT 1' } as Prisma.Sql)).resolves.toEqual([{ id: 1 }]);
    expect(log).toEqual([
      'SET TRANSACTION READ ONLY',
      'SET LOCAL statement_timeout = 1000',
      'SET LOCAL jit = off',
      'SELECT pg_is_in_recovery() AS standby',
      'SELECT 1',
    ]);
    expect(() => standbyQuery(async () => [] as never, 1.5)).toThrow('positive integer');
  });

  it('reads the posted sample with the co-occurrence eligibility, and hands on an image whose attachments resolve to nothing with no resources', async () => {
    const batchSql: string[] = [];
    const query = async (q: Prisma.Sql) => {
      if (q.sql.includes('max(id)')) return [{ max: 100 }];
      if (q.sql.includes('ORDER BY id LIMIT 1')) {
        const id = q.values[0] as number;
        return [{ id, createdAt: new Date(id < 40 ? '2026-01-01' : '2026-03-01') }];
      }
      batchSql.push(q.sql);
      return [
        { userId: 1, prompt: 'a', resources: null, reactions: 0, tips: 0 },
        {
          userId: 2,
          prompt: 'b',
          resources: [{ modelId: 3, type: 'LORA', baseModel: 'E', listed: true }],
          reactions: 4,
          tips: 1,
        },
      ];
    };
    const got: TagTrainingRow[] = [];
    const r = await readPostedSample(query, {
      start: new Date('2026-02-01'),
      end: new Date('2026-04-01'),
      mod: 6,
      idBatch: 1000,
      userKey: (id) => `u${id}`,
      onBatch: (rows) => void got.push(...rows),
    });
    expect(r).toMatchObject({ idLo: 40, batches: 1 });
    expect(batchSql.length).toBe(1);
    expect(batchSql[0]).toContain(COOC_ELIGIBLE_REST);
    expect(got.map((x) => [x.user, x.resources.length])).toEqual([
      ['u1', 0],
      ['u2', 1],
    ]);
  });

  it('retries a failed statement, and gives up after the last try', async () => {
    let calls = 0;
    const flaky = async () => {
      if (++calls < 3) throw new Error('connection closed');
      return [{ ok: 1 }];
    };
    await expect(retryingQuery(flaky, 0)({} as Prisma.Sql)).resolves.toEqual([{ ok: 1 }]);
    expect(calls).toBe(3);
    calls = -10;
    await expect(retryingQuery(flaky, 0)({} as Prisma.Sql)).rejects.toThrow('connection closed');
    expect(calls).toBe(-7);
  });
});

describe('the eligible models (full coverage)', () => {
  /** A table of models; the fake applies the statement's own keyset bound and LIMIT. */
  const keysetQuery = (ids: number[], seen: Prisma.Sql[]) => async (q: Prisma.Sql) => {
    seen.push(q);
    const [after, , page] = q.values as [number, string[], number];
    return ids
      .filter((id) => id > after)
      .slice(0, page)
      .map((id) => ({ id }));
  };

  it('reads every eligible id in keyset pages, ascending, under the eligibility predicate', async () => {
    const seen: Prisma.Sql[] = [];
    const ids = [3, 5, 8, 13, 21];
    expect(await readEligibleModelIds(keysetQuery(ids, seen), ['LORA', 'Checkpoint'], 2)).toEqual(
      ids
    );
    // Pages after 0, 5 and 13; the third is short, so it is the last.
    expect(seen.map((q) => q.values[0])).toEqual([0, 5, 13]);
    expect(seen[0].values[1]).toEqual(['LORA', 'Checkpoint']);
    // The whole statement: each clause is an eligibility rule a reword could drop.
    expect(seen[0].sql.replace(/\s+/g, ' ').trim()).toBe(
      'SELECT m.id FROM "Model" m WHERE m.id > ?::int AND ' +
        'NOT m.poi AND NOT m.minor AND ' +
        `m.status = 'Published' AND m.availability <> 'Private'::"Availability" AND m.mode IS NULL AND ` +
        'm.type::text = ANY(?::text[]) ' +
        'AND EXISTS (SELECT 1 FROM "ModelVersion" mv WHERE mv."modelId" = m.id AND ' +
        "mv.status = 'Published') ORDER BY m.id LIMIT ?::int"
    );
  });

  it('a last page exactly full reads one more, empty, page', async () => {
    const seen: Prisma.Sql[] = [];
    expect(await readEligibleModelIds(keysetQuery([1, 2, 3, 4], seen), ['LORA'], 2)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(seen.map((q) => q.values[0])).toEqual([0, 2, 4]);
  });

  it('pages 50,000 ids at a time by default', async () => {
    expect(ELIGIBLE_MODEL_PAGE).toBe(50_000);
    const seen: Prisma.Sql[] = [];
    await readEligibleModelIds(keysetQuery([1], seen), ['LORA']);
    expect(seen[0].values[2]).toBe(50_000);
  });

  it('refuses ids that are not ascending: the keyset bound would skip or repeat models', async () => {
    const query = async () => [{ id: 4 }, { id: 4 }];
    await expect(readEligibleModelIds(query, ['LORA'], 5)).rejects.toThrow('not ascending');
    for (const bad of [0, 1.5, -1])
      await expect(readEligibleModelIds(query, ['LORA'], bad)).rejects.toThrow('positive integer');
  });

  it('unions two ascending id lists, without duplicates', () => {
    expect(unionAscending([1, 4, 9], [2, 4, 10, 11])).toEqual([1, 2, 4, 9, 10, 11]);
    expect(unionAscending([], [3, 5])).toEqual([3, 5]);
    expect(unionAscending([3, 5], [])).toEqual([3, 5]);
    expect(unionAscending([7], [7])).toEqual([7]);
  });
});

describe('content batches are read ahead, and handed on in id order', () => {
  /** Content reads that resolve when the test says, so the order of hand-on is under its control. */
  function gatedQuery() {
    const pending: {
      ids: number[];
      kind: 'meta' | 'images';
      done: boolean;
      resolve: () => void;
    }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const query = (q: Prisma.Sql) => {
      const ids = q.values.find(Array.isArray) as number[];
      const kind = q.sql.includes('"TagsOnModels"') ? 'meta' : 'images';
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<unknown[]>((res) => {
        const item = {
          ids,
          kind,
          done: false,
          resolve: () => {
            item.done = true;
            inFlight--;
            res(
              kind === 'meta'
                ? ids.map((id) => ({
                    id,
                    name: `m${id}`,
                    type: 'LORA',
                    description: '',
                    tags: [],
                    versions: [],
                  }))
                : []
            );
          },
        } as (typeof pending)[number];
        pending.push(item);
      });
    };
    return { query, pending, maxInFlight: () => maxInFlight };
  }
  const settle = () => new Promise((r) => setImmediate(r));
  const ids = Array.from({ length: 5000 }, (_, i) => i + 1);

  it('reads three batches at once by default', async () => {
    expect(CONTENT_READ_CONCURRENCY).toBe(3);
    const g = gatedQuery();
    const done = readModelContent(g.query, ids, new Date(), () => undefined);
    for (;;) {
      await settle();
      const p = g.pending.find((x) => !x.done);
      if (!p) break;
      p.resolve();
    }
    await done;
    expect(g.maxInFlight()).toBe(3);
  });

  it('keeps at most `concurrency` batches reading, and hands them on in id order however they finish', async () => {
    const g = gatedQuery();
    const handed: number[] = [];
    const done = readModelContent(
      g.query,
      ids,
      new Date(),
      (m) => void handed.push(m[0].modelId),
      2
    );
    await settle();
    // Batches 1 and 2 are reading (their meta statements); batch 3 waits for a slot.
    expect(g.pending.map((p) => p.ids[0])).toEqual([1, 1001]);
    // Batch 2 finishes first; nothing is handed on before batch 1.
    for (const kind of ['meta', 'images'] as const) {
      g.pending.find((p) => p.ids[0] === 1001 && p.kind === kind)?.resolve();
      await settle();
    }
    expect(handed).toEqual([]);
    for (;;) {
      const p = g.pending.find((x) => !x.done);
      if (!p) break;
      p.resolve();
      await settle();
    }
    await done;
    expect(handed).toEqual([1, 1001, 2001, 3001, 4001]);
    expect(g.maxInFlight()).toBe(2);
  });

  it('with concurrency 1, reads one batch at a time', async () => {
    const g = gatedQuery();
    const done = readModelContent(g.query, ids, new Date(), () => undefined, 1);
    for (;;) {
      await settle();
      const p = g.pending.find((x) => !x.done);
      if (!p) break;
      p.resolve();
    }
    await done;
    expect(g.maxInFlight()).toBe(1);
    expect(g.pending).toHaveLength(10);
  });

  it('a read-ahead that fails after the read has failed is not left unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const query = async (q: Prisma.Sql) => {
        const ids = q.values.find(Array.isArray) as number[];
        if (ids[0] === 1001) throw new Error('batch two failed');
        // Batch three fails later, on a timer, once nothing awaits it any more.
        if (ids[0] === 2001) {
          await new Promise((r) => setTimeout(r, 10));
          throw new Error('batch three failed');
        }
        return q.sql.includes('"TagsOnModels"')
          ? ids.map((id) => ({
              id,
              name: '',
              type: 'LORA',
              description: '',
              tags: [],
              versions: [],
            }))
          : [];
      };
      await expect(readModelContent(query, ids, new Date(), () => undefined)).rejects.toThrow(
        'batch two failed'
      );
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('once a batch fails, a read-ahead still running issues no further statement', async () => {
    const statements: string[] = [];
    const query = async (q: Prisma.Sql) => {
      const ids = q.values.find(Array.isArray) as number[];
      const kind = q.sql.includes('"TagsOnModels"') ? 'meta' : 'images';
      statements.push(`${kind} ${ids[0]}`);
      if (ids[0] === 1001) throw new Error('batch two failed');
      // Batch three's meta answers only after batch two has failed.
      if (ids[0] === 2001 && kind === 'meta') await new Promise((r) => setTimeout(r, 10));
      return kind === 'meta'
        ? ids.map((id) => ({ id, name: '', type: 'LORA', description: '', tags: [], versions: [] }))
        : [];
    };
    await expect(readModelContent(query, ids, new Date(), () => undefined)).rejects.toThrow(
      'batch two failed'
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(statements).toContain('meta 2001');
    expect(statements).not.toContain('images 2001');
  });

  it('batch one slow, batch two failing first: no statement after the failure, no batch launched', async () => {
    const statements: string[] = [];
    const query = async (q: Prisma.Sql) => {
      const ids = q.values.find(Array.isArray) as number[];
      const kind = q.sql.includes('"TagsOnModels"') ? 'meta' : 'images';
      statements.push(`${kind} ${ids[0]}`);
      if (ids[0] === 1001) throw new Error('batch two failed');
      // Batch two fails at once; batches one (slowest) and three answer their meta after that.
      if (kind === 'meta' && ids[0] !== 1001)
        await new Promise((r) => setTimeout(r, ids[0] === 1 ? 10 : 1));
      return kind === 'meta'
        ? ids.map((id) => ({ id, name: '', type: 'LORA', description: '', tags: [], versions: [] }))
        : [];
    };
    await expect(readModelContent(query, ids, new Date(), () => undefined)).rejects.toThrow(
      'batch two failed'
    );
    await new Promise((r) => setTimeout(r, 30));
    // The three read at once, and nothing after: no image read, no fourth batch.
    expect(statements).toEqual(['meta 1', 'meta 1001', 'meta 2001']);
  });

  it('a failed batch fails the read, and hands on nothing after it', async () => {
    const handed: number[] = [];
    const query = async (q: Prisma.Sql) => {
      const ids = q.values.find(Array.isArray) as number[];
      if (ids[0] === 1001) throw new Error('batch two failed');
      return q.sql.includes('"TagsOnModels"')
        ? ids.map((id) => ({ id, name: '', type: 'LORA', description: '', tags: [], versions: [] }))
        : [];
    };
    await expect(
      readModelContent(query, ids, new Date(), (m) => void handed.push(m[0].modelId))
    ).rejects.toThrow('batch two failed');
    expect(handed).toEqual([1]);
    for (const bad of [0, 1.5])
      await expect(readModelContent(query, ids, new Date(), () => undefined, bad)).rejects.toThrow(
        'positive integer'
      );
  });
});

describe('only listed models reach the index: Published, not Private, Archived or TakenDown', () => {
  // The columns the model-admitting reads look at, with the app's own enum types.
  const SCHEMA = `
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "Model" (id int PRIMARY KEY, status text, poi boolean, minor boolean, type text,
      availability "Availability", mode "ModelModifier");
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, status text, "baseModel" text);
  `;
  // id: [availability, mode, status]. 1, 5 and 6 are listed; 2, 3 and 4 are one each of Private,
  // Archived and TakenDown; 7–10 one each of the statuses that are not Published.
  const MODELS: [number, string, string | null, string][] = [
    [1, 'Public', null, 'Published'],
    [2, 'Private', null, 'Published'],
    [3, 'Public', 'Archived', 'Published'],
    [4, 'Public', 'TakenDown', 'Published'],
    [5, 'Unsearchable', null, 'Published'],
    [6, 'EarlyAccess', null, 'Published'],
    [7, 'Public', null, 'Deleted'],
    [8, 'Public', null, 'Unpublished'],
    [9, 'Public', null, 'UnpublishedViolation'],
    [10, 'Public', null, 'Draft'],
  ];
  async function db() {
    const d = await utcPglite(SCHEMA);
    for (const [id, availability, mode, status] of MODELS) {
      await d.query(
        `INSERT INTO "Model" VALUES ($1, $4, false, false, 'LORA', $2::"Availability", $3::"ModelModifier")`,
        [id, availability, mode, status]
      );
      await d.query(`INSERT INTO "ModelVersion" VALUES ($1, $2, 'Published', 'SDXL 1.0')`, [
        id * 10,
        id,
      ]);
    }
    return pgliteSql(d);
  }

  it('the eligibility read admits only the listed models', async () => {
    const sql = await db();
    expect(await readEligibleModelIds((q) => sql.query(q), ['LORA'])).toEqual([1, 5, 6]);
  });

  it('a generator row drops an unlisted model it used, and keeps the rest of the row', async () => {
    const sql = await db();
    const versions = await fetchVersionInfo(
      (q) => sql.query(q),
      MODELS.map(([id]) => id * 10)
    );
    expect([...versions].filter(([, v]) => v.unlisted).map(([id]) => id)).toEqual([
      20, 30, 40, 70, 80, 90, 100,
    ]);
    const row = genTrainingRow(
      {
        user: 'u',
        prompt: 'p',
        versionIds: MODELS.map(([id]) => id * 10),
        liked: true,
        favorite: false,
        disliked: false,
      },
      versions
    );
    expect(row?.resources.map((r) => r.modelId)).toEqual([1, 5, 6]);
  });

  it('the posted-row resources and the model content use the same predicate', async () => {
    const seen: Prisma.Sql[] = [];
    const query = async (q: Prisma.Sql) => {
      seen.push(q);
      if (q.sql.includes('max(id)')) return [{ max: 10 }];
      if (q.sql.includes('FROM "Image" WHERE id >='))
        return [{ id: q.values[0], createdAt: new Date('2026-01-15') }];
      return [];
    };
    await readModelContent(query, [1], new Date(), () => undefined);
    await readPostedSample(query, {
      start: new Date('2026-01-01'),
      end: new Date('2026-02-01'),
      mod: 6,
      idBatch: 100,
      userKey: String,
      onBatch: () => undefined,
    });
    const meta = seen.find((q) => q.sql.includes('"TagsOnModels"'));
    const posted = seen.find((q) => q.sql.includes('jsonb_agg(DISTINCT'));
    expect(meta?.sql).toContain(`AND ${MODEL_LISTED_SQL}`);
    expect(posted?.sql.replace(/\s+/g, ' ')).toContain(
      `'baseModel', mv."baseModel", 'listed', ${MODEL_LISTED_SQL}))`
    );
    expect(MODEL_LISTED_SQL).toBe(
      `m.status = 'Published' AND m.availability <> 'Private'::"Availability" AND m.mode IS NULL`
    );
  });
});

describe("a row's ecosystem comes from every checkpoint it used, listed or not", () => {
  const vocab = parseTagVocabulary(
    Buffer.from(
      JSON.stringify({
        schema: 'p2m-vocab/2',
        tags: [{ id: 0, key: 'castle', idf: 1, users: 3, explicit: false, near: [] }],
      })
    )
  );
  const v = (modelId: number, type: string, baseModel: string, unlisted: boolean): VersionInfo => ({
    modelId,
    type,
    baseModel,
    flagged: false,
    unlisted,
  });
  /** The ecosystems one generator row and one posted row with the same resources are counted under. */
  function ecosystemsOf(versions: Map<number, VersionInfo>) {
    const acc = new TagIndexAccumulator(vocab, {
      addonTypes: ['LORA'],
      excludeGenPrompt: () => false,
    });
    const gen = genTrainingRow(
      {
        user: 'u',
        prompt: 'castle',
        versionIds: [...versions.keys()],
        liked: true,
        favorite: false,
        disliked: false,
      },
      versions
    );
    acc.addRow(gen as TagTrainingRow);
    const { data } = acc.finalize();
    return { resources: gen?.resources.map((r) => r.modelId), ecosystems: data.ecosystems };
  }

  it('an unlisted SDXL checkpoint beside a listed SDXL LoRA: the row keeps SDXL', () => {
    const got = ecosystemsOf(
      new Map([
        [10, v(1, 'Checkpoint', 'SDXL 1.0', true)],
        [20, v(2, 'LORA', 'SDXL 1.0', false)],
      ])
    );
    expect(got.resources).toEqual([2]);
    expect(got.ecosystems).toEqual([{ name: 'SDXL 1.0', users: 1, observations: 1 }]);
  });

  it('an unlisted Pony checkpoint beside a listed SDXL checkpoint: still no single ecosystem', () => {
    const got = ecosystemsOf(
      new Map([
        [10, v(1, 'Checkpoint', 'Pony', true)],
        [20, v(2, 'Checkpoint', 'SDXL 1.0', false)],
      ])
    );
    expect(got.resources).toEqual([2]);
    expect(got.ecosystems.filter((e) => e.observations > 0)).toEqual([]);
  });

  it('a posted row does the same: its unlisted attachments count for the ecosystem only', async () => {
    const rows: TagTrainingRow[] = [];
    const query = async (q: Prisma.Sql) => {
      if (q.sql.includes('max(id)')) return [{ max: 10 }];
      if (q.sql.includes('FROM "Image" WHERE id >='))
        return [{ id: q.values[0], createdAt: new Date('2026-01-15') }];
      return [
        {
          userId: 1,
          prompt: 'castle',
          resources: [
            { modelId: 1, type: 'Checkpoint', baseModel: 'SDXL 1.0', listed: false },
            { modelId: 2, type: 'LORA', baseModel: 'SDXL 1.0', listed: true },
          ],
          reactions: 0,
          tips: 0,
        },
      ];
    };
    await readPostedSample(query, {
      start: new Date('2026-01-01'),
      end: new Date('2026-02-01'),
      mod: 6,
      idBatch: 100,
      userKey: String,
      onBatch: (r) => void rows.push(...r),
    });
    expect(rows[0].resources).toEqual([{ modelId: 2, type: 'LORA', baseModel: 'SDXL 1.0' }]);
    const acc = new TagIndexAccumulator(vocab, {
      addonTypes: ['LORA'],
      excludeGenPrompt: () => false,
    });
    acc.addRow(rows[0]);
    expect(acc.finalize().data.ecosystems).toEqual([
      { name: 'SDXL 1.0', users: 1, observations: 1 },
    ]);
  });
});
