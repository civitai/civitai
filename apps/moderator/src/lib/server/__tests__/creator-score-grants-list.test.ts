import { describe, expect, it, vi } from 'vitest';

/**
 * The grant list on User Lookup.
 *
 * The query is correct only in its emitted SQL: keyed on the target's `userId` (the indexed column,
 * and the only thing that keeps another account's grants off this page), read from the primary.
 */

const captured = vi.hoisted(() => [] as string[]);
const capturedParams = vi.hoisted(() => [] as unknown[][]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  const db = capturingDb(captured, [], capturedParams);
  // dbRead throws, so any replica read fails the test.
  const replica = new Proxy(
    {},
    {
      get: () => {
        throw new Error('creator score grants must be read from the primary');
      },
    }
  );
  return { dbRead: replica, dbWrite: db };
});

const { listCreatorScoreGrants } = await import('../creator-score-grant.service');

const compile = async () => {
  captured.length = 0;
  capturedParams.length = 0;
  await listCreatorScoreGrants(8675309);
  expect(captured).toHaveLength(1);
  return { sql: captured[0], params: capturedParams[0] };
};

describe('listCreatorScoreGrants SQL', () => {
  it("reads one account's grants by the indexed userId", async () => {
    const { sql, params } = await compile();
    expect(sql).toContain('from "CreatorScoreGrant" as "g"');
    const user = /where "g"\."userId" = \$(\d+)/.exec(sql);
    expect(user).not.toBeNull();
    expect(params[Number(user![1]) - 1]).toBe(8675309);
  });

  it('names the granter and revoker without dropping a grant whose moderator is gone', async () => {
    const { sql } = await compile();
    expect(sql).toContain('left join "User" as "granter" on "granter"."id" = "g"."grantedById"');
    expect(sql).toContain('left join "User" as "revoker" on "revoker"."id" = "g"."revokedById"');
  });

  it('newest first, capped', async () => {
    const { sql, params } = await compile();
    expect(sql).toMatch(/order by "g"\."createdAt" desc/);
    const limit = /limit \$(\d+)/.exec(sql);
    expect(limit).not.toBeNull();
    expect(params[Number(limit![1]) - 1]).toBe(50);
  });
});
