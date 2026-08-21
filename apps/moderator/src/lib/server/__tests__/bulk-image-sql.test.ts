import { describe, expect, it, vi } from 'vitest';

/**
 * The model and model-version sources build their `IN` list as a RAW fragment, and Kysely splices raw
 * into `where(..., 'in', ...)` VERBATIM — it only parenthesises a real subquery builder. Without the
 * fragment's own parens the emitted SQL is `where "i"."id" in SELECT ...`, which Postgres rejects with
 * 42601 before it runs anything, so both sources 500 outright.
 *
 * A real compile is the only thing that catches this: the shape typechecks, lints, and a hand-rolled
 * chain fake cannot see it. So `dbRead` here is real Kysely on a driver that never connects, and the
 * assertions read the SQL it actually emitted.
 */

const captured = vi.hoisted(() => [] as string[]);

// Built inside the factory, not in `vi.hoisted`: hoisted blocks run before this file's own imports, so
// constructing Kysely there reads it before initialisation.
vi.mock('$lib/server/db', async () => {
  const { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } =
    await import('kysely');
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (i) => new PostgresIntrospector(i),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (e) => {
      if (e.level === 'query') captured.push(e.query.sql);
    },
  });
  return { dbRead: db, dbWrite: db };
});
vi.mock('$lib/server/user-actions.service', () => ({
  issueStrike: vi.fn(),
  removeImages: vi.fn(),
  setImageFlag: vi.fn(),
}));

const { getImagesForModel, getImagesForModelVersion } = await import('../bulk-image.service');

/** Both halves of the batch carry the same predicate, and the count is the one that rejected first. */
const run = async (fn: () => Promise<unknown>) => {
  captured.length = 0;
  await fn();
  expect(captured.length).toBeGreaterThanOrEqual(2);
  return captured;
};

describe('bulk image sources that build their IN list as raw SQL', () => {
  it('parenthesises the model union so Postgres can parse it', async () => {
    for (const statement of await run(() => getImagesForModel(2877758, 200, 0))) {
      expect(statement).toContain('in (');
      expect(statement).not.toMatch(/in\s+SELECT/i);
    }
  });

  it('parenthesises the model-version union too', async () => {
    for (const statement of await run(() => getImagesForModelVersion(3252190, 200, 0))) {
      expect(statement).toContain('in (');
      expect(statement).not.toMatch(/in\s+SELECT/i);
    }
  });
});
