import { useHotkeys } from '@mantine/hooks';
import produce from 'immer';
import { useRouter } from 'next/router';
import { createContext, useContext, useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCollection } from '~/components/Collections/collection.utils';
import type { ImagesQueryParamSchema } from '~/components/Image/image.utils';
import { parseImageQueryParams, useQueryImages } from '~/components/Image/image.utils';
import type { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import type { CollectionByIdModel, ImageGetInfinite } from '~/types/router';
import { QS } from '~/utils/qs';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

type ImageDetailState = {
  images: ImageGetInfinite;
  isLoading: boolean;
  active: boolean;
  connect: ConnectProps;
  isMod?: boolean;
  isOwner?: boolean;
  shareUrl: string;
  index: number;
  toggleInfo: () => void;
  close: () => void;
  navigate: (id: number) => void;
  loadMore: () => void;
  hasMore: boolean;
  updateImage: (id: number, data: Partial<ImagesInfiniteModel>) => void;
  collection?: CollectionByIdModel;
  hideReactions?: boolean;
};

const ImageDetailContext = createContext<ImageDetailState | null>(null);
export const useImageDetailContext = () => {
  const context = useContext(ImageDetailContext);
  if (!context) throw new Error('useImageDetailContext not found in tree');
  return context;
};

export function ImageDetailProvider({
  children,
  imageId,
  images: initialImages = [],
  hideReactionCount,
  hideReactions,
  filters,
  collectionId,
  withoutPost,
}: {
  children: React.ReactElement;
  imageId: number;
  images?: ImagesInfiniteModel[];
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  filters: ImagesQueryParamSchema;
  collectionId?: number;
  withoutPost?: boolean;
}) {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();

  // Only do this so that we have it pre-fetched
  const { collection } = useCollection(collectionId as number, {
    enabled: !!collectionId,
  });

  // `browserRouter.query` holds raw strings, so reading `postId` off it with a cast
  // was not a parse: on `?postId=null` this handed the string 'null' to the `??`
  // below, it beat the parsed filter, and `image.getInfinite` was called with a
  // string against an input schema typed `z.number()` — a guaranteed failed request
  // on every load of the very links this page was fixed to serve. Parse it the same
  // way the filters are parsed; `active` is a genuine boolean read and stays a cast.
  const { postId: queryPostId } = parseImageQueryParams(browserRouter.query);
  const { active = false } = browserRouter.query as { active?: boolean };
  const { modelId, modelVersionId, username, userId, reactions, postId: filterPostId } = filters;
  const postId = queryPostId ?? filterPostId;
  // #region [data fetching]
  const shouldFetchMany = !initialImages?.length && (Object.keys(filters).length > 0 || !!postId);
  const browsingLevel = useBrowsingLevelDebounced();
  const {
    images: queryImages = [],
    isInitialLoading: imagesLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useQueryImages(
    // TODO: Hacky way to prevent sending the userId when filtering by reactions
    { ...filters, userId: !!reactions?.length ? undefined : userId, postId, browsingLevel },
    { enabled: shouldFetchMany }
  );

  const usingQueryImages = initialImages.length === 0;
  const baseImages = usingQueryImages ? queryImages : initialImages;

  // Seeded from a feed card, `images` is a fixed window the feed handed us — only
  // the query we own here can grow.
  const hasMore = usingQueryImages && shouldFetchMany && !!hasNextPage;
  const loadMore = () => {
    if (hasMore && !isFetchingNextPage) fetchNextPage();
  };

  const shouldFetchImage =
    !imagesLoading && (baseImages.length === 0 || !baseImages.find((x) => x.id === imageId));
  // TODO - this needs to return the data as `ImagesInfiniteModel`
  // alternatively, we always query multiple images, with the cursor starting at `imageId`
  const { data: prefetchedImage, isInitialLoading: imageQueryLoading } = trpc.image.get.useQuery(
    { id: imageId, withoutPost },
    { enabled: shouldFetchImage }
  );
  // A disabled observer still reports `isInitialLoading` while *another* observer
  // fetches the same key. `/images/[imageId]` renders this provider too and reads
  // its id from the same router store, so opening a routed image dialog over it
  // puts two providers on one id: the page owns the fetch, and the dialog — which
  // already has the image — showed a full-page loader over content that never
  // went away. Only report loading for a fetch we asked for.
  const imageLoading = shouldFetchImage && imageQueryLoading;

  // Prepended, not `unshift`ed: a routed dialog's props come from the immer-backed
  // dialog store, which deep-freezes them, and react-query freezes cached data in
  // dev — so mutating this in render threw `Cannot add property N, object is not
  // extensible`. Element identity is preserved because `updateImage` writes
  // through `images[index]` by reference.
  const images =
    prefetchedImage && shouldFetchImage ? [prefetchedImage as any, ...baseImages] : baseImages;

  function findCurrentImageIndex() {
    const index = images.findIndex((x) => x.id === imageId);
    return index > -1 ? index : 0;
  }

  const index = findCurrentImageIndex();

  const updateImage = (id: number, data: Partial<ImagesInfiniteModel>) => {
    queryUtils.image.getInfinite.setInfiniteData(
      { ...filters, userId: !!reactions?.length ? undefined : userId, postId, browsingLevel },
      produce((queryData) => {
        if (!queryData?.pages?.length) return;

        for (const page of queryData.pages)
          for (const item of page.items) {
            if (item.id === id) {
              Object.assign(item, data);
              break;
            }
          }
      })
    );

    queryUtils.image.get.setData(
      { id },
      produce((old) => {
        if (!old) {
          return old;
        }

        Object.assign(old, data);
        const index = images.findIndex((x) => x.id === id);
        if (index !== -1) Object.assign(images[index], data);
      })
    );
  };
  // #endregion

  // #region [back button functionality]
  const close = () => {
    if (hasHistory) browserRouter.back();
    else {
      const [, queryString] = browserRouter.asPath.split('?');
      const { active, ...query } = QS.parse(queryString) as any;

      if (active) browserRouter.replace({ query: browserRouter.query }, { query });
      else {
        const returnUrl = getReturnUrl({ postId, modelId, modelVersionId, username }) ?? '/images';
        router.push(returnUrl, undefined, { shallow: true });
      }
    }
  };
  useHotkeys([['Escape', close]]);

  // #region [info toggle]
  const toggleInfo = () => {
    if (!active)
      browserRouter.push({ query: { ...browserRouter.query, active: true } }, browserRouter.asPath);
    else if (active) browserRouter.back();
  };
  // #endregion

  // #region [navigation]
  const navigate = (id: number) => {
    const query = browserRouter.query;
    const [, queryString] = browserRouter.asPath.split('?');
    browserRouter.replace(
      { query: { ...query, imageId: id } },
      {
        pathname: `/images/${id}`,
        query: QS.parse(queryString) as any,
      }
    );
  };

  // #endregion

  const shareUrl = useMemo(() => {
    const [pathname, queryString] = browserRouter.asPath.split('?');
    const { active, ...query } = QS.parse(queryString);
    return Object.keys(query).length > 0 ? `${pathname}?${QS.stringify(query)}` : pathname;
  }, [browserRouter]);

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === images[index]?.user.id;

  const connect: ConnectProps = modelId
    ? { connectType: 'model', connectId: modelId }
    : postId
    ? { connectType: 'post', connectId: postId }
    : username
    ? { connectType: 'user', connectId: username }
    : {};

  const image = images[index];
  const { blockedUsers } = useHiddenPreferencesData();
  const isBlocked = blockedUsers.find((u) => u.id === image?.user.id);

  if (imagesLoading || imageLoading) return <PageLoader />;
  if (!image || isBlocked) return <NotFound />;

  return (
    <ImageDetailContext.Provider
      value={{
        images,
        isLoading: imagesLoading || imageLoading,
        active,
        connect,
        toggleInfo,
        close,
        isOwner,
        isMod,
        shareUrl,
        navigate,
        loadMore,
        hasMore,
        index,
        updateImage,
        collection,
        hideReactions,
      }}
    >
      {children}
    </ImageDetailContext.Provider>
  );
}

const getReturnUrl = ({
  postId,
  modelId,
  modelVersionId,
  username,
}: {
  postId?: number;
  modelId?: number;
  modelVersionId?: number;
  username?: string;
}) => {
  if (modelId) {
    return getModelUrl({ modelId, modelVersionId });
  } else if (postId) {
    return `/posts/${postId}`;
  } else if (username) {
    return `/user/${username}/images`;
  }
};
