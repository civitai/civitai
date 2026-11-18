import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import type { LabDB } from '../xguard-lab';
import { importNamedSamples } from '../xguard-named-samples';

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
  await pg.exec(LAB_SCHEMA);
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
    .select(['source', 'batch', 'user_id', 'positive_prompt', 'negative_prompt', 'live_scores'])
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
      },
      {
        prompt_hash: GENERATED.promptHash,
        source: 'xguardPromptResults',
        batch: 'review-1',
        user_id: 11,
        positive_prompt: 'generated positive',
        negative_prompt: 'generated negative',
        live_scores: { CR: 0.1, Young: 0.9 },
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

  it.each([
    ['a non-numeric generated hash', { generated: ['1) OR (1=1'] }],
    ['a non-numeric refused hash', { refused: [{ hash: "1'", date: '2026-11-15' }] }],
    ['a malformed refused date', { refused: [{ hash: '1', date: "2026-11-15' OR '1" }] }],
  ])('refuses %s before querying anything', async (_name, part) => {
    const query = fakeClickhouse();
    await expect(
      importNamedSamples({ batch: 'review-1', ...part }, { query, db })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a set larger than the cap before querying anything', async () => {
    const query = fakeClickhouse();
    const generated = Array.from({ length: 501 }, (_, i) => String(i));
    await expect(
      importNamedSamples({ batch: 'review-1', generated }, { query, db })
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
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
      blind: { seed: 20261118 },
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
});
