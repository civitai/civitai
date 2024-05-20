import { useDidUpdate, useHotkeys, useLocalStorage } from '@mantine/hooks';
import { ConnectProps } from '~/components/ImageGuard/ImageGuard2';
import { useQueryImages } from '~/components/Image/image.utils';
import { ReviewReactions } from '@prisma/client';
import { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { ImageGetById, ImageGetInfinite } from '~/types/router';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';
import { removeEmpty } from '../../../utils/object-helpers';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';

type ImageDetailState = {
  images: ImageGetInfinite;
  image?: ImageGetInfinite[number] | ImageGetById;
  isLoading: boolean;
  active: boolean;
  connect: ConnectProps;
  isMod?: boolean;
  isOwner?: boolean;
  shareUrl: string;
  canNavigate?: boolean;
  index: number;
  toggleInfo: () => void;
  close: () => void;
  next: () => void;
  previous: () => void;
  navigate: (id: number) => void;
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
  filters,
}: {
  children: React.ReactElement;
  imageId: number;
  images?: ImagesInfiniteModel[];
  hideReactionCount?: boolean;
  filters: {
    postId?: number;
    modelId?: number;
    modelVersionId?: number;
    username?: string;
    limit?: number;
    prioritizedUserIds?: number[];
    tags?: number[];
    reactions?: ReviewReactions[];
    collectionId?: number;
  } & Record<string, unknown>;
}) {
  const router = useRouter();
  const browserRouter = useBrowserRouter();
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();
  const { postId: queryPostId, active = false } = browserRouter.query as {
    postId?: number;
    active?: boolean;
  };
  const { modelId, modelVersionId, username, reactions, postId: filterPostId } = filters;
  const postId = queryPostId ?? filterPostId;
  // #region [data fetching]
  const shouldFetchMany = !initialImages?.length && (Object.keys(filters).length > 0 || !!postId);
  const browsingLevel = useBrowsingLevelDebounced();
  const { images: queryImages = [], isInitialLoading: imagesLoading } = useQueryImages(
    // TODO: Hacky way to prevent sending the username when filtering by reactions
    { ...filters, username: !!reactions?.length ? undefined : username, postId, browsingLevel },
    {
      enabled: shouldFetchMany,
    }
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

  useEffect(() => {
    if (prefetchedImage && shouldFetchImage) {
      browserRouter.replace(
        {
          query: removeEmpty({
            ...browserRouter.query,
            postId: prefetchedImage.postId || undefined,
          }),
        },
        `/images/${imageId}`
      );
    }
  }, [prefetchedImage]); // eslint-disable-line

  function findCurrentImageIndex() {
    const index = images.findIndex((x) => x.id === imageId);
    return index > -1 ? index : 0;
  }

  const index = findCurrentImageIndex();
  const image = images[index];
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
  const prevIndex = index - 1;
  const nextIndex = index + 1;
  const canNavigate = images.length > 1;

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

  return (
    <ImageDetailContext.Provider
      value={{
        images,
        image,
        isLoading: !image ? imagesLoading || imageLoading : imageLoading,
        active,
        connect,
        toggleInfo,
        close,
        next,
        previous,
        isOwner,
        isMod,
        shareUrl,
        canNavigate,
        navigate,
        index,
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
