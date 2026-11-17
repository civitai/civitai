import { PGlite } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FIXTURE, migration } from '~/server/services/__tests__/comment-v3-fixture';

/** Each CommentTopic partition the schema migration creates cascades from its entity row. */

vi.setConfig({ hookTimeout: 120_000, testTimeout: 60_000 });

const db = { pg: null as unknown as PGlite };

beforeAll(async () => {
  db.pg = new PGlite({ extensions: { ltree } });
  await db.pg.exec(FIXTURE);
  await db.pg.exec(migration('20261110120000_comment_v3_schema'));
});
afterAll(async () => {
  await db.pg.close();
});

describe('every comment topic cascades from its entity', () => {
  it('has an ON DELETE CASCADE entityId key on each partition the schema migration creates', async () => {
    const { rows } = await db.pg.query<{ partition: string; cascades: boolean }>(`
      SELECT c.relname AS partition, EXISTS (
        SELECT 1 FROM pg_constraint k
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
        WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confdeltype = 'c'
          AND a.attname = 'entityId' AND cardinality(k.conkey) = 1
      ) AS cascades
      FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = '"CommentTopic"'::regclass ORDER BY 1
    `);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((r) => !r.cascades)).toEqual([]);
  });

  // A partition a later migration adds is checked by no-uncascaded-comment-topic-partition.test.ts.
});
