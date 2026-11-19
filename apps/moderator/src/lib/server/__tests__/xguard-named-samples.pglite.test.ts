import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { executableSchemaSql, pgliteDialect } from './abuse-detection-pglite.harness';
import type { LabDB } from '../xguard-lab';
import {
  buildNamedSampleQueries,
  importNamedSamples,
  NamedSampleInputError,
  namedSampleClickhouseConfig,
  REFUSED_PROMPT_HASH_SQL,
} from '../xguard-named-samples';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_SCHEMA = readFileSync(join(HERE, '../../../../xguard-lab/schema.sql'), 'utf8');

const GENERATED = {
  promptHash: '-4611686018427387904',
  promptCreatedAt: '2026-11-18 10:00:00',
  userId: 11,
  positivePrompt: 'generated positive',
  negativePrompt: 'generated negative',
  scores: { CR: 0.1, Young: 0.9 },
};
const REFUSED = {
  promptHash: '9876543210',
  promptCreatedAt: '2026-11-15 08:00:00',
  userId: 22,
  positivePrompt: 'refused positive',
  negativePrompt: 'refused negative',
};

let pg: PGlite;
let db: Kysely<LabDB>;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(executableSchemaSql(LAB_SCHEMA));
  db = new Kysely<LabDB>({ dialect: pgliteDialect(pg) });
});

afterEach(() => pg.close());

const fakeClickhouse = () =>
  vi.fn(async (sql: string): Promise<any[]> => {
    if (sql.includes('orchestration.xguardPromptResults')) {
      return sql.includes(GENERATED.promptHash) ? [GENERATED] : [];
    }
    if (sql.includes('prohibitedRequests')) {
      return sql.includes(REFUSED.promptHash) ? [REFUSED] : [];
    }
    throw new Error('unexpected query');
  });

const rows = () =>
  db
    .selectFrom('sample')
    // Production's pg driver returns bigint as a string; pglite returns a number or a BigInt.
    .select(sql<string>`prompt_hash::text`.as('prompt_hash'))
    .select([
      'source',
      'batch',
      'user_id',
      'positive_prompt',
      'negative_prompt',
      'live_scores',
      'prompt_created_at',
    ])
    .orderBy('source')
    .execute();

const manyClickhouse = () =>
  vi.fn(async (sql: string): Promise<any[]> => {
    const ids = [...sql.matchAll(/IN \(([^)]*)\)/g)].pop()?.[1].split(',') ?? [];
    const generated = sql.includes('orchestration.xguardPromptResults');
    return ids.map((id) => ({
      promptHash: id,
      promptCreatedAt: '2026-11-15 08:00:00',
      userId: 5,
      positivePrompt: `p${id}`,
      negativePrompt: `n${id}`,
      ...(generated ? { scores: { CR: 0.5 } } : {}),
    }));
  });

describe('importNamedSamples', () => {
  it("loads a named set from both sources, keeping the negative prompt and each row's origin", async () => {
    const query = fakeClickhouse();
    const summary = await importNamedSamples(
      {
        batch: 'review-1',
        generated: [GENERATED.promptHash],
        refused: [{ hash: REFUSED.promptHash, date: '2026-11-15' }],
      },
      { query, db }
    );

    expect(summary).toEqual({
      batch: 'review-1',
      requested: 2,
      inserted: 2,
      duplicates: 0,
      missing: { generated: [], refused: [] },
    });
    expect(await rows()).toEqual([
      {
        prompt_hash: REFUSED.promptHash,
        source: 'prohibitedRequests',
        batch: 'review-1',
        user_id: 22,
        positive_prompt: 'refused positive',
        negative_prompt: 'refused negative',
        live_scores: null,
        prompt_created_at: new Date('2026-11-15T08:00:00.000Z'),
      },
      {
        prompt_hash: GENERATED.promptHash,
        source: 'xguardPromptResults',
        batch: 'review-1',
        user_id: 11,
        positive_prompt: 'generated positive',
        negative_prompt: 'generated negative',
        live_scores: { CR: 0.1, Young: 0.9 },
        prompt_created_at: new Date('2026-11-18T10:00:00.000Z'),
      },
    ]);
  });

  it('names every requested hash it could not find instead of dropping it', async () => {
    const summary = await importNamedSamples(
      {
        batch: 'review-1',
        generated: [GENERATED.promptHash, '123'],
        refused: [{ hash: '456', date: '2026-11-15' }],
      },
      { query: fakeClickhouse(), db }
    );

    expect(summary.inserted).toBe(1);
    expect(summary.missing).toEqual({ generated: ['123'], refused: ['456'] });
  });

  it('is idempotent per batch: a re-run counts duplicates and inserts nothing', async () => {
    const req = { batch: 'review-1', generated: [GENERATED.promptHash] };
    await importNamedSamples(req, { query: fakeClickhouse(), db });
    const again = await importNamedSamples(req, { query: fakeClickhouse(), db });

    expect(again).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await rows()).toHaveLength(1);
  });

  it('blind: strips every field that could reveal where a row came from', async () => {
    await importNamedSamples(
      {
        batch: 'review-1',
        generated: ['1', '2'],
        refused: [{ hash: '3', date: '2026-11-15' }],
        blind: { seed: 7 },
      },
      { query: manyClickhouse(), db }
    );
    const stored = await db
      .selectFrom('sample')
      .select(['source', 'user_id', 'live_scores', 'prompt_created_at'])
      .execute();
    expect(stored).toHaveLength(3);
    for (const row of stored) {
      expect(row).toEqual({
        source: 'named',
        user_id: null,
        live_scores: null,
        prompt_created_at: null,
      });
    }
  });

  it('blind: stores rows in a seeded shuffle, the same for the same seed', async () => {
    const req = (batch: string) => ({
      batch,
      generated: ['1', '2', '3'],
      refused: ['4', '5', '6'].map((hash) => ({ hash, date: '2026-11-15' })),
      blind: { seed: 4242 },
    });
    await importNamedSamples(req('a'), { query: manyClickhouse(), db });
    await importNamedSamples(req('b'), { query: manyClickhouse(), db });
    const order = async (batch: string) =>
      (
        await db
          .selectFrom('sample')
          .select(sql<string>`prompt_hash::text`.as('h'))
          .where('batch', '=', batch)
          .orderBy('id')
          .execute()
      ).map((r) => r.h);

    const a = await order('a');
    expect(a).toEqual(await order('b'));
    expect([...a].sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(a).not.toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('blind: a different seed gives a different order', async () => {
    const req = (batch: string, seed: number) => ({
      batch,
      generated: ['1', '2', '3', '4', '5', '6'],
      blind: { seed },
    });
    await importNamedSamples(req('a', 1), { query: manyClickhouse(), db });
    await importNamedSamples(req('b', 2), { query: manyClickhouse(), db });
    const order = async (batch: string) =>
      (
        await db
          .selectFrom('sample')
          .select(sql<string>`prompt_hash::text`.as('h'))
          .where('batch', '=', batch)
          .orderBy('id')
          .execute()
      ).map((r) => r.h);
    expect(await order('a')).not.toEqual(await order('b'));
  });

  it.each([
    ['blind into a batch that already holds plain rows', false, true],
    ['blind into a batch that already holds blind rows', true, true],
    ['plain into a blind batch', true, false],
  ])('refuses to load %s', async (_name, firstBlind, secondBlind) => {
    const load = (hash: string, blind: boolean) =>
      importNamedSamples(
        { batch: 'review-1', generated: [hash], ...(blind ? { blind: { seed: 1 } } : {}) },
        { query: manyClickhouse(), db }
      );
    await load('1', firstBlind);
    await expect(load('2', secondBlind)).rejects.toBeInstanceOf(NamedSampleInputError);
    expect(await rows()).toHaveLength(1);
  });

  it('counts a partly new set as inserted plus duplicates, and a repeated hash once', async () => {
    await importNamedSamples(
      { batch: 'review-1', generated: ['1'] },
      { query: manyClickhouse(), db }
    );
    const summary = await importNamedSamples(
      { batch: 'review-1', generated: ['1', '2', '2'] },
      { query: manyClickhouse(), db }
    );
    expect(summary).toMatchObject({ requested: 2, inserted: 1, duplicates: 1 });
  });

  it('looks a refused hash given with two days up on both, and counts it once', async () => {
    const query = manyClickhouse();
    const summary = await importNamedSamples(
      {
        batch: 'review-1',
        refused: [
          { hash: '9', date: '2026-11-17' },
          { hash: '9', date: '2026-11-18' },
        ],
      },
      { query, db }
    );
    expect(query.mock.calls[0][0]).toContain("createdDate IN ('2026-11-17','2026-11-18')");
    expect(summary).toMatchObject({ requested: 1, inserted: 1 });
  });

  it('accepts exactly the cap across both lists', async () => {
    const summary = await importNamedSamples(
      {
        batch: 'review-1',
        generated: Array.from({ length: 250 }, (_, i) => String(i + 1)),
        refused: Array.from({ length: 250 }, (_, i) => ({
          hash: String(i + 1001),
          date: '2026-11-15',
        })),
      },
      { query: manyClickhouse(), db }
    );
    expect(summary.inserted).toBe(500);
  });

  it.each([
    [
      'over the cap across both lists',
      {
        generated: Array.from({ length: 250 }, (_, i) => String(i + 1)),
        refused: Array.from({ length: 251 }, (_, i) => ({
          hash: String(i + 1001),
          date: '2026-11-15',
        })),
      },
    ],
    ['a non-numeric generated hash', { generated: ['1) OR (1=1'] }],
    ['a non-numeric refused hash', { refused: [{ hash: "1'", date: '2026-11-15' }] }],
    ['a malformed refused date', { refused: [{ hash: '1', date: "2026-11-15' OR '1" }] }],
    ['a hash with a leading zero', { generated: ['0123'] }],
    ['a 19-digit hash above the Int64 maximum', { generated: ['9999999999999999999'] }],
    ['negative zero', { generated: ['-0'] }],
    ['a hash wider than Int64', { generated: ['12345678901234567890'] }],
    ['a fractional seed', { generated: ['1'], blind: { seed: 1.5 } }],
    [
      'more distinct days than the cap',
      {
        refused: Array.from({ length: 32 }, (_, i) => ({
          hash: String(i + 1),
          date: `2026-10-${String(i + 1).padStart(2, '0')}`,
        })),
      },
    ],
  ])('refuses %s as an input error, before querying anything', async (_name, part) => {
    const query = fakeClickhouse();
    await expect(
      importNamedSamples({ batch: 'review-1', ...part }, { query, db })
    ).rejects.toBeInstanceOf(NamedSampleInputError);
    expect(query).not.toHaveBeenCalled();
  });
});

const flat = (s: string | null) => s?.replace(/\s+/g, ' ').trim();

describe('lab schema: blind batches', () => {
  let next = 0;
  const insert = (batch: string, source: string, extra = '') => {
    const [col, value] = extra ? extra.split(/=(.*)/s) : [];
    return pg.exec(
      `INSERT INTO sample (prompt_hash, source, batch, positive_prompt${col ? `, ${col}` : ''})
       VALUES (${++next}, '${source}', '${batch}', 'x'${col ? `, ${value}` : ''})`
    );
  };

  it('refuses a plain row into a blind batch, from any writer', async () => {
    await insert('b', 'named');
    await expect(insert('b', 'xguardPromptResults')).rejects.toThrow(/mixes blind and plain rows/);
  });

  it('refuses a blind row into a plain batch', async () => {
    await insert('p', 'xguardPromptResults');
    await expect(insert('p', 'named')).rejects.toThrow(/mixes blind and plain rows/);
  });

  it('refuses a second blind load, so each blind batch is one shuffled block', async () => {
    await insert('b', 'named');
    await expect(insert('b', 'named')).rejects.toThrow(/was already loaded/);
  });

  it('accepts a blind batch written in one statement', async () => {
    await pg.exec(`INSERT INTO sample (prompt_hash, source, batch, positive_prompt)
      VALUES (1, 'named', 'b', 'x'), (2, 'named', 'b', 'y')`);
    const { rows } = await pg.query(`SELECT 1 FROM sample WHERE batch = 'b'`);
    expect(rows).toHaveLength(2);
  });

  it('lets a lone row be renamed without counting itself as a clash', async () => {
    await insert('p', 'xguardPromptResults');
    await pg.exec(`UPDATE sample SET source = 'named' WHERE batch = 'p'`);
    const { rows } = await pg.query(`SELECT source FROM sample WHERE batch = 'p'`);
    expect(rows).toEqual([{ source: 'named' }]);
  });

  it.each([
    ['an owner', 'user_id=1'],
    ['scores', `live_scores='{"CR":0.1}'`],
    ['a date', `prompt_created_at='2026-11-15T00:00:00Z'`],
  ])('refuses a blind row that carries %s', async (_name, extra) => {
    await expect(insert('b', 'named', extra)).rejects.toThrow(/sample_blind_rows_carry_no_hints/);
  });

  it('still accepts owner, scores and date on plain rows', async () => {
    await insert('p', 'xguardPromptResults', 'user_id=1');
    await insert('p', 'prohibitedRequests', `live_scores='{"CR":0.2}'`);
    await insert('p', 'xguardPromptResults', `prompt_created_at='2026-11-15T00:00:00Z'`);
    const { rows } = await pg.query(`SELECT 1 FROM sample WHERE batch = 'p'`);
    expect(rows).toHaveLength(3);
  });

  it('can be re-applied to a database that already has it', async () => {
    await expect(pg.exec(executableSchemaSql(LAB_SCHEMA))).resolves.toBeDefined();
  });
});

// Pinned as whole statements: the fake ClickHouse never runs them, and the refused lookup once failed
// live because an outer alias named like a column was substituted into its WHERE.
describe('buildNamedSampleQueries', () => {
  it('filters refused rows by day and hash inside a subquery, then groups by hash', () => {
    const { refused } = buildNamedSampleQueries([], ['7', '-8'], ['2026-11-15', '2026-11-16']);
    expect(flat(refused)).toBe(
      flat(`SELECT toString(h) AS promptHash, toString(min(time)) AS promptCreatedAt,
        argMin(userId, time) AS userId, any(p) AS positivePrompt, any(n) AS negativePrompt
        FROM ( SELECT ${REFUSED_PROMPT_HASH_SQL} AS h, time, userId, prompt AS p,
          ifNull(negativePrompt, '') AS n
          FROM default.prohibitedRequests
          WHERE createdDate IN ('2026-11-15','2026-11-16')
            AND ${REFUSED_PROMPT_HASH_SQL} IN (7,-8) )
        GROUP BY h`)
    );
  });

  it('takes every generated column from the earliest row', () => {
    const { generated } = buildNamedSampleQueries(['5'], [], []);
    expect(flat(generated)).toBe(
      flat(`SELECT toString(promptHash) AS promptHash, toString(min(createdAt)) AS promptCreatedAt,
        argMin(userId, createdAt) AS userId, argMin(positivePrompt, createdAt) AS positivePrompt,
        argMin(negativePrompt, createdAt) AS negativePrompt, argMin(scores, createdAt) AS scores
        FROM orchestration.xguardPromptResults
        WHERE promptHash IN (5)
        GROUP BY promptHash`)
    );
  });
});

describe('namedSampleClickhouseConfig', () => {
  it('makes every query read-only and time-boxed', () => {
    const { host } = namedSampleClickhouseConfig({ host: 'https://ch.example:8443/' });
    const url = new URL(host);
    expect(url.searchParams.get('readonly')).toBe('2');
    expect(url.searchParams.get('max_execution_time')).toBe('30');
  });
});
