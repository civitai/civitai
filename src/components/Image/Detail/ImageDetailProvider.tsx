import { useMemo } from 'react';
import { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { useImageFilters } from '~/providers/FiltersProvider';

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
  const router = useRouter();
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();

  // #region [data fetching]
  /**
   * NOTE: consider what props are being passed to the query when we are querying by things like `postId`
   */
  // the globally set filter values should only be applied when accessing the image detail from the image gallery
  const globalImageFilters = useImageFilters();
  const filters = !postId && !modelId && !username ? globalImageFilters : {};

  const { data, isLoading } = trpc.image.getInfinite.useInfiniteQuery(
    {
      postId,
      modelId,
      username,
      ...filters,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
    }
  );

  const { data: prefetchedImage } = trpc.image.getDetail.useQuery(
    { id: imageId },
    { enabled: false }
  );

  const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);
  const image = images.find((x) => x.id === imageId) ?? prefetchedImage;
  // #endregion

  // #region [navigation]
  /**NOTES**
  - when our current image is not found in the images array, we can navigate away from it, but we can't use the arrows to navigate back to it.
*/
  const index = images.findIndex((x) => x.id === imageId);
  const prevIndex = index - 1;
  const nextIndex = index + 1;
  const canNavigate = index > -1 ? images.length > 1 : images.length > 0; // see notes

  const navigate = (id: number) => {
    const { imageId, ...query } = router.query;
    const [, queryString] = router.asPath.split('?');
    router.replace(
      { query: { ...query, imageId: id } },
      {
        pathname: `/images/${id}`,
        query: QS.parse(queryString) as any,
      },
      {
        shallow: true,
      }
    );
  };

  const previous = () => {
    if (canNavigate) {
      const id = prevIndex > -1 ? images[prevIndex].id : images[images.length - 1].id;
      navigate(id);
    }
  };

  const next = () => {
    if (canNavigate) {
      const id = nextIndex < images.length ? images[nextIndex].id : images[0].id;
      navigate(id);
    }
  };
  // #endregion

  const shareUrl = useMemo(() => {
    const [pathname, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString);
    return Object.keys(query).length > 0 ? `${pathname}?${QS.stringify(query)}` : pathname;
  }, [router]);

  return <>{children}</>;
}
