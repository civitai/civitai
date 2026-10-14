import { QueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { describe, expect, it } from 'vitest';

import { trpc } from '~/utils/trpc';

/**
 * After a branch choice the viewer invalidates `getForkShares` with `{ chapterId }` only, while
 * the cached read is keyed `{ chapterId, browsingLevel }`. That relies on tRPC's `invalidate`
 * building a type-"any" key that react-query matches partially. If this fails, shares stop
 * refreshing after a choice: pass the full input or invalidate the procedure instead.
 */
describe('fork shares refresh after a choice', () => {
  const cached = (chapterId: number) =>
    getQueryKey(trpc.storyline.getForkShares, { chapterId, browsingLevel: 7 }, 'query');

  it('invalidating by chapter alone reaches the read cached at a browsing level', async () => {
    const client = new QueryClient();
    client.setQueryData(cached(3), { enough: false });
    client.setQueryData(cached(4), { enough: false });
    await client.invalidateQueries({
      queryKey: getQueryKey(trpc.storyline.getForkShares, { chapterId: 3 }, 'any'),
    });
    expect([
      client.getQueryState(cached(3))?.isInvalidated,
      client.getQueryState(cached(4))?.isInvalidated,
    ]).toEqual([true, false]);
  });
});
