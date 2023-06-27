import { useMemo } from 'react';
import { GetGenerationRequestsInput } from '~/server/schema/generation.schema';
import { trpc } from '~/utils/trpc';
export const useGetGenerationRequests = (
  input: GetGenerationRequestsInput,
  options?: { enabled?: boolean; onError: (err: unknown) => void }
) => {
  const { data, ...rest } = trpc.generation.getRequests.useInfiniteQuery(input, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    // getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    ...options,
  });
  const requests = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])) ?? [], [data]);

  return { data, requests, ...rest };
};
