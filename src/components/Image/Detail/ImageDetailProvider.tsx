import { useMemo, useEffect, useContext, createContext } from 'react';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { useHotkeys } from '@mantine/hooks';
import { ImageGuardConnect } from '~/components/ImageGuard/ImageGuard';
import { useQueryImages } from '~/components/Image/image.utils';
import { ReviewReactions } from '@prisma/client';
import { ImageGetById, ImageGetInfinite } from '~/types/router';
import { ReactionSettingsProvider } from '~/components/Reaction/ReactionSettingsProvider';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { ImagesInfiniteModel } from '~/server/services/image.service';
import { removeEmpty } from '../../../utils/object-helpers';

type ImageDetailState = {
  images: ImageGetInfinite;
  image?: ImageGetInfinite[number] | ImageGetById;
  isLoading: boolean;
  active: boolean;
  connect?: ImageGuardConnect;
  isMod?: boolean;
  isOwner?: boolean;
  shareUrl: string;
  canNavigate?: boolean;
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
  const active = browserRouter.query.active;
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();
  const { postId: queryPostId } = browserRouter.query;
  const { modelId, modelVersionId, username, reactions, postId: filterPostId } = filters;
  const postId = queryPostId ?? filterPostId;
  // #region [data fetching]
  const shouldFetchMany = !initialImages?.length && (Object.keys(filters).length > 0 || !!postId);
  const { images: queryImages = [], isInitialLoading: imagesLoading } = useQueryImages(
    // TODO: Hacky way to prevent sending the username when filtering by reactions
    { ...filters, username: !!reactions?.length ? undefined : username, postId },
    {
      enabled: shouldFetchMany,
    }
  );
  const images = initialImages.length > 0 ? initialImages : queryImages;

  const shouldFetchImage =
    !imagesLoading && (images.length === 0 || !images.find((x) => x.id === imageId));
  const { data: prefetchedImage, isInitialLoading: imageLoading } = trpc.image.get.useQuery(
    { id: imageId },
    { enabled: shouldFetchImage }
  );

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

  // const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);
  const image = images.find((x) => x.id === imageId) ?? prefetchedImage ?? undefined;
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
    const [, queryString] = browserRouter.asPath.split('?');
    const { active, ...query } = QS.parse(queryString) as any;

    browserRouter.push(
      { query: { ...browserRouter.query, active: !active } },
      { query: { ...query, active: !active } }
    );
  };
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
  const isOwner = currentUser?.id === image?.user.id;
  const connect: ImageGuardConnect | undefined = username
    ? { entityType: 'user', entityId: username }
    : postId
    ? { entityType: 'post', entityId: postId }
    : modelId
    ? { entityType: 'model', entityId: modelId }
    : undefined;

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
      }}
    >
      <ReactionSettingsProvider settings={{ hideReactionCount }}>
        {children}
      </ReactionSettingsProvider>
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
