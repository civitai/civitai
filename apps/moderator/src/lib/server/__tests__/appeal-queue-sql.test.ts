import { describe, expect, it, vi } from 'vitest';

/**
 * The appeals queue renders through `ImageQueueGrid`, which keys its `{#each}` on the image id. So any
 * join in this query that can match an image more than once does not degrade — it throws
 * `each_key_duplicate` and Svelte tears the page down mid-render. That is what took the Appeals tab
 * black on 2026-08-25: `ModActivity` holds one row per review, an appealed image has been reviewed at
 * least once and usually more, and the join had no LIMIT.
 *
 * A real compile is what catches it. The fan-out typechecks perfectly, the fake-row unit tests all pass,
 * and the only evidence is in the emitted SQL — so `dbRead` here is real Kysely on a driver that never
 * connects, and the assertions read what it actually produced.
 */

const captured = vi.hoisted(() => [] as string[]);

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
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));

const { getAppealImageQueue } = await import('../image-review.service');

const compileQueue = async () => {
  captured.length = 0;
  await getAppealImageQueue({ browsingLevel: 1, limit: 20 });
  const sql = captured.find((s) => s.includes('ModActivity'));
  if (!sql) throw new Error('the appeal queue emitted no query touching ModActivity');
  return sql;
};

describe('getAppealImageQueue SQL', () => {
  it('reaches ModActivity only through a lateral, so it cannot multiply an image', async () => {
    const sql = await compileQueue();

    // The bug shape, stated directly: a plain join on a table with N rows per image returns N copies.
    expect(sql).not.toMatch(/left join "ModActivity"/);
    expect(sql).toMatch(/left join lateral \(select[^)]*from "ModActivity"/);
  });

  it('caps that lateral at one row and takes the LATEST review', async () => {
    const sql = await compileQueue();
    const lateral = sql.slice(sql.indexOf('from "ModActivity"'));

    // Ordering is not cosmetic: the card reads "Removed ... by X", so an unordered LIMIT 1 attributes
    // the removal to whichever moderator Postgres happened to return.
    expect(lateral).toMatch(/order by "ma"\."createdAt" desc/);
    expect(lateral).toMatch(/limit \$?\d+/);
  });

  it('still returns one appeal per image', async () => {
    const sql = await compileQueue();
    // The appeal join had this right already; asserted so a future edit cannot "simplify" it into the
    // same fan-out this file exists to prevent.
    expect(sql).toMatch(/join lateral \(select[^)]*from "Appeal"/);
    expect(sql).not.toMatch(/join "Appeal" as/);
  });
});
