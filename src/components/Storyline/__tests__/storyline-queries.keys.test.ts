import { QueryClient } from '@tanstack/react-query';
import { createTRPCClient } from '@trpc/client';
import { createTRPCQueryUtils, getQueryKey } from '@trpc/react-query';
import { describe, expect, it } from 'vitest';

import type { AppRouter } from '~/server/routers';
import { trpc } from '~/utils/trpc';

/**
 * After a branch choice the viewer calls `utils.storyline.getForkShares.invalidate({ chapterId })`
 * while the cached read is keyed `{ chapterId, browsingLevel }`. That relies on tRPC building a
 * partial key for `invalidate` that react-query matches. If this fails, shares stop refreshing
 * after a choice: pass the full input or invalidate the whole procedure instead.
 */
describe('fork shares refresh after a choice', () => {
  const cached = (chapterId: number) =>
    getQueryKey(trpc.storyline.getForkShares, { chapterId, browsingLevel: 7 }, 'query');

  it('invalidating by chapter alone reaches the read cached at a browsing level', async () => {
    const queryClient = new QueryClient();
    const utils = createTRPCQueryUtils<AppRouter>({
      queryClient,
      client: createTRPCClient<AppRouter>({ links: [] }),
    });
    queryClient.setQueryData(cached(3), { enough: false });
    queryClient.setQueryData(cached(4), { enough: false });
    await utils.storyline.getForkShares.invalidate({ chapterId: 3 });
    expect([
      queryClient.getQueryState(cached(3))?.isInvalidated,
      queryClient.getQueryState(cached(4))?.isInvalidated,
    ]).toEqual([true, false]);
  });
});
