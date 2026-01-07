import { useHotkeys } from '@mantine/hooks';
import produce from 'immer';
import { useRouter } from 'next/router';
import { createContext, useContext, useMemo } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCollection } from '~/components/Collections/collection.utils';
import type { ImagesQueryParamSchema } from '~/components/Image/image.utils';
import { useQueryImages } from '~/components/Image/image.utils';
import type { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import type { CollectionByIdModel, ImageGetInfinite } from '~/types/router';
import { QS } from '~/utils/qs';
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
}: {
  children: React.ReactElement;
  imageId: number;
  images?: ImagesInfiniteModel[];
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  filters: ImagesQueryParamSchema;
  collectionId?: number;
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

  const { postId: queryPostId, active = false } = browserRouter.query as {
    postId?: number;
    active?: boolean;
  };
  const { modelId, modelVersionId, username, userId, reactions, postId: filterPostId } = filters;
  const postId = queryPostId ?? filterPostId;
  // #region [data fetching]
  const shouldFetchMany = !initialImages?.length && (Object.keys(filters).length > 0 || !!postId);
  const browsingLevel = useBrowsingLevelDebounced();
  const { images: queryImages = [], isInitialLoading: imagesLoading } = useQueryImages(
    // TODO: Hacky way to prevent sending the userId when filtering by reactions
    { ...filters, userId: !!reactions?.length ? undefined : userId, postId, browsingLevel },
    { enabled: shouldFetchMany }
  );

  const images = initialImages.length > 0 ? initialImages : queryImages;

  const shouldFetchImage =
    !imagesLoading && (images.length === 0 || !images.find((x) => x.id === imageId));
  // TODO - this needs to return the data as `ImagesInfiniteModel`
  // alternatively, we always query multiple images, with the cursor starting at `imageId`
  const { data: prefetchedImage, isInitialLoading: imageLoading } = trpc.image.get.useQuery(
    { id: imageId },
    { enabled: shouldFetchImage }
  );

  if (prefetchedImage && shouldFetchImage) {
    images.unshift(prefetchedImage as any);
  }

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
    const url = `/models/${modelId}`;
    return modelVersionId ? `${url}?modelVersionId=${modelVersionId}` : url;
  } else if (postId) {
    return `/posts/${postId}`;
  } else if (username) {
    return `/user/${username}/images`;
  }
};
