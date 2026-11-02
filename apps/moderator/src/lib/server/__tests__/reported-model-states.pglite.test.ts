import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** What the model report pane reads about a reported model's state, on the real SQL. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));

const { getReportedModelStates } = await import('../reports.service');

let pg: PGlite;
beforeEach(async () => {
  pg = await freshPglite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(`
    CREATE TABLE "Model" (
      id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL, mode TEXT, minor BOOLEAN DEFAULT false,
      "sfwOnly" BOOLEAN DEFAULT false, poi BOOLEAN DEFAULT false, nsfw BOOLEAN DEFAULT false,
      "deletedAt" TIMESTAMP(3), meta JSONB
    );
    INSERT INTO "Model" (id, name, status, meta) VALUES
      (1, 'taken down', 'UnpublishedViolation', '{"unpublishedReason": "other"}'),
      (2, 'kept', 'UnpublishedViolation', '{"removedWithOwner": true}'),
      (3, 'odd meta', 'Published', '"x"');
  `);
});

describe('getReportedModelStates', () => {
  it('tells a model kept when its owner was wiped from one taken down', async () => {
    const states = await getReportedModelStates([1, 2, 3]);
    expect(Object.fromEntries(states.map((s) => [s.id, s.removedWithOwner]))).toEqual({
      1: false,
      2: true,
      3: false,
    });
  });
});
