import { beforeEach, describe, expect, it } from 'vitest';
import { listModelEngagements } from './model.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

// Pins the EXACT SQL because the port's premise is that the statement is unchanged. Behaviour parity
// against the Prisma original is covered against a real database by
// src/server/db/__tests__/kysely-prisma-parity.test.ts.
describe('model.db', () => {
  it('listModelEngagements filters by userId AND the model id list, selecting modelId + type', async () => {
    await listModelEngagements(harness.db, { userId: 7, modelIds: [1, 2, 3] });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toBe(
      'select "modelId", "type" from "ModelEngagement" ' +
        'where "userId" = $1 and "modelId" in ($2, $3, $4)'
    );
    expect(parameters).toEqual([7, 1, 2, 3]);
    expect(sql).not.toContain('in ()');
    expect(sql).not.toContain('order by'); // the source query had none
  });

  it('listModelEngagements short-circuits an empty id list without touching the DB', async () => {
    const rows = await listModelEngagements(harness.db, { userId: 7, modelIds: [] });
    expect(rows).toEqual([]);
    expect(harness.queries).toHaveLength(0); // `in ([])` would compile to the syntax error `IN ()`
  });

  it('listModelEngagements keeps the userId predicate for a single-id lookup', async () => {
    // The narrowest input a caller can pass; dropping userId here would return every user's
    // engagement with that model.
    await listModelEngagements(harness.db, { userId: 7, modelIds: [1] });
    const { sql, parameters } = harness.lastQuery();
    expect(sql).toContain('"userId" = $1');
    expect(parameters).toEqual([7, 1]);
  });
});
