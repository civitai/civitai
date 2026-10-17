import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  COOC_ELIGIBLE_ATTACHMENTS,
  COOC_ELIGIBLE_IMAGE,
  COOC_ELIGIBLE_REST,
} from '~/server/services/resource-intent-cooc/build';
import type { TagModelContent, TagTrainingRow } from '~/server/services/resource-intent-tags/build';
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
  ELIGIBLE_MODEL_PAGE,
  readEligibleModelIds,
  readModelContent,
  readPostedSample,
  retryingQuery,
  standbyQuery,
  tagTrainingWindow,
  unionAscending,
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
          resources: [{ modelId: 3, type: 'LORA', baseModel: 'E' }],
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
        "m.status = 'Published' AND NOT m.poi AND NOT m.minor AND m.type::text = ANY(?::text[]) " +
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

  it('reads three batches at once by default', () => {
    expect(CONTENT_READ_CONCURRENCY).toBe(3);
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
