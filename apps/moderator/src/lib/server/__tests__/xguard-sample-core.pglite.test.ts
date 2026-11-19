import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';

const HERE = dirname(fileURLToPath(import.meta.url));
const LAB_SCHEMA = readFileSync(join(HERE, '../../../../xguard-lab/schema.sql'), 'utf8');

const { pgHandle } = vi.hoisted(() => ({ pgHandle: { current: null as PGlite | null } }));

// sampleBatch opens its own pg.Client; route it to the in-process database.
vi.mock('pg', () => ({
  default: {
    Client: class {
      async connect() {
        return undefined;
      }
      async end() {
        return undefined;
      }
      async query(text: string, params: unknown[]) {
        const res = await pgHandle.current!.query(text, params);
        // pg reports the row count for a SELECT too; pglite only counts written rows.
        return { rows: res.rows, rowCount: res.affectedRows || res.rows.length };
      }
    },
  },
}));

const { sampleBatch } = await import('../../../../xguard-lab/sample-core');

let pg: PGlite;

beforeEach(async () => {
  pg = await freshPglite();
  await pg.exec(LAB_SCHEMA);
  pgHandle.current = pg;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            promptHash: '42',
            promptCreatedAt: '2026-11-18 10:00:00',
            userId: 1,
            positivePrompt: 'a sampled prompt',
            scores: { Young: 0.5 },
          }) + '\n'
        )
    )
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await pg.close();
});

const run = (batch: string) =>
  sampleBatch({
    connectionString: 'unused',
    batch,
    size: 1,
    bands: 1,
    clickhouse: { host: 'http://clickhouse.test' },
  });

describe('sampleBatch', () => {
  it('stores the live scores of what it samples', async () => {
    await run('plain');
    const { rows } = await pg.query<{ live_scores: unknown }>(
      `SELECT live_scores FROM sample WHERE batch = 'plain'`
    );
    expect(rows).toEqual([{ live_scores: { Young: 0.5 } }]);
  });

  it('refuses to add rows to a blind batch', async () => {
    await pg.exec(
      `INSERT INTO sample (prompt_hash, source, batch, positive_prompt) VALUES (1, 'named', 'blind', 'x')`
    );
    await expect(run('blind')).rejects.toThrow(/mixes blind and plain rows/);
    const { rows } = await pg.query(`SELECT 1 FROM sample WHERE batch = 'blind'`);
    expect(rows).toHaveLength(1);
  });
});
