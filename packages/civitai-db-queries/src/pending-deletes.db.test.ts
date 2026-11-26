import { beforeEach, describe, expect, it } from 'vitest';
import { imagesPendingDeletion } from './pending-deletes.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('imagesPendingDeletion', () => {
  // Without the cast Postgres rejects the query with: operator does not exist: "EntityType" = text,
  // so image.get failed for every owner opening their own image (5.1.550).
  it('casts the queued entity type to the EntityType enum', async () => {
    await imagesPendingDeletion(harness.db, [1]);
    const { sql } = harness.lastQuery();
    expect(sql).toMatch(/pdq\."entityType" = \$\d+::"EntityType"/);
    expect(sql).not.toMatch(/"entityType" = \$\d+(?!::)/);
  });
});
