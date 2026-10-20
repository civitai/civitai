import { describe, expect, it } from 'vitest';
import type { kyselyV3Write } from '~/server/db/kyselyDb';

// Type-only: the v3 handles must refuse writes to the tree columns Postgres generates or sets by
// trigger. Nothing here runs; `pnpm run typecheck` is the assertion.
declare const w: typeof kyselyV3Write;

function treeColumnsAreSelectOnly() {
  // @ts-expect-error rootId is GENERATED
  w.insertInto('CommentV3').values({ rootId: 1 });
  // @ts-expect-error depth is GENERATED
  w.updateTable('CommentV3').set({ depth: 1 });
  // @ts-expect-error path is set by trigger
  w.updateTable('CommentV3').set({ path: '1' });
  return w.selectFrom('CommentV3').select(['rootId', 'depth', 'path']);
}

describe('kyselyV3Write', () => {
  it('types the tree columns as select-only', () => {
    expect(typeof treeColumnsAreSelectOnly).toBe('function');
  });
});
