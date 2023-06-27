import { Generation } from '~/server/services/generation/generation.types';
import { useMemo } from 'react';
import { GetGenerationRequestsInput } from '~/server/schema/generation.schema';
import { trpc } from '~/utils/trpc';

export const useGetGenerationImages = (
  input: GetGenerationRequestsInput,
  options?: { enabled?: boolean }
) => {
  const { data, ...rest } = trpc.generation.getImages.useInfiniteQuery(input, {
    getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
    // getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
    ...options,
  });
  const images = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.images : [])) ?? [], [data]);
  const requestData = useMemo(
    () =>
      data?.pages.reduce<Generation.Client.ImageRequestDictionary>(
        (acc, { requests }) => ({ ...acc, ...requests }),
        {}
      ) ?? {},
    [data]
  );

  return { data, images, requestData, ...rest };
};
