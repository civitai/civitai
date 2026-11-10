import { describe, expect, it } from 'vitest';
import { reduceJobQueueToIds } from '~/server/jobs/job-queue';
import type { EntityType } from '~/shared/utils/prisma/enums';

describe('reduceJobQueueToIds', () => {
  // A queue row left over from a type that no longer queues must not open an `undefined` bucket.
  it('skips a leftover CommentV2 row and still collects a real type', () => {
    const ids = reduceJobQueueToIds([
      { entityType: 'CommentV2' as EntityType, entityId: 5 },
      { entityType: 'Post' as EntityType, entityId: 9 },
    ]);

    expect(Object.keys(ids).sort()).toEqual(Object.keys(reduceJobQueueToIds([])).sort());
    expect(ids.postIds).toEqual([9]);
  });
});
