import { useMemo } from 'react';
import { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { trpc } from '~/utils/trpc';

export function ImageDetailProvider({
  children,
  imageId,
  postId,
  modelId,
  username,
}: {
  children: React.ReactElement;
  imageId: number;
  postId?: number;
  modelId?: number;
  username?: string;
}) {
  /**
   * NOTE: consider what props are being passed to the query when we are querying by things like `postId`
   */
  const { data, isLoading } = trpc.image.getInfinite.useInfiniteQuery(
    {
      postId,
      modelId,
      username,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
    }
  );

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);
  const image = images.find((x) => x.id === imageId);

  return <></>;
}
