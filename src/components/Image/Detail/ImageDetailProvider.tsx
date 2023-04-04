import { useMemo, useRef, useEffect, useContext, createContext } from 'react';
import { ImageV2Model } from '~/server/selectors/imagev2.selector';
import { trpc } from '~/utils/trpc';
import { useRouter } from 'next/router';
import { QS } from '~/utils/qs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { useImageFilters } from '~/providers/FiltersProvider';
import { useHotkeys } from '@mantine/hooks';
import { ImageGuardConnect } from '~/components/ImageGuard/ImageGuard';
import { removeEmpty } from '~/utils/object-helpers';
import { useQueryImages } from '~/components/Image/image.utils';

type ImageDetailState = {
  images: ImageV2Model[];
  image?: ImageV2Model;
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
  filters,
}: {
  children: React.ReactElement;
  imageId: number;
  filters: {
    postId?: number;
    modelId?: number;
    modelVersionId?: number;
    username?: string;
    limit?: number;
    prioritizedUserIds?: number[];
    tags?: number[];
  } & Record<string, unknown>;
}) {
  const router = useRouter();
  const active = router.query.active === 'true';
  const closingRef = useRef(false);
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();
  const { postId, modelId, modelVersionId, username } = filters;

  // #region [data fetching]
  const { images, isLoading } = useQueryImages(filters);

  // TODO.Briant - return to this
  const shouldFetchImage = !!images?.length && !images.find((x) => x.id === imageId);
  const { data: prefetchedImage } = trpc.image.get.useQuery({ id: imageId }, { enabled: false });

  // const images = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);
  const image = images.find((x) => x.id === imageId) ?? prefetchedImage ?? undefined;
  // #endregion

  // #region [back button functionality]
  const close = () => {
    if (closingRef.current) return;
    if (hasHistory) router.back();
    else {
      const [, queryString] = router.asPath.split('?');
      const { active, ...query } = QS.parse(queryString) as any;

      if (active) router.replace({ query: router.query }, { query }, { shallow: true });
      else {
        const returnUrl = getReturnUrl({ postId, modelId, modelVersionId, username }) ?? '/images';
        router.push(returnUrl, undefined, { shallow: true });
      }
    }
  };
  useHotkeys([['Escape', close]]);

  const handleClosingStart = () => {
    closingRef.current = true;
  };
  const handleClosingEnd = () => {
    closingRef.current = false;
  };

  useEffect(() => {
    router.events.on('routeChangeStart', handleClosingStart);
    router.events.on('routeChangeComplete', handleClosingEnd);

    return () => {
      router.events.off('routeChangeStart', handleClosingStart);
      router.events.off('routeChangeComplete', handleClosingEnd);
    };
  }, []); //eslint-disable-line
  // #endregion

  // #region [info toggle]
  const toggleInfo = () => {
    const [, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString) as any;

    router.push(
      { query: { ...router.query, active: !active } },
      { query: { ...query, active: !active } },
      { shallow: true }
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
        isLoading,
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
