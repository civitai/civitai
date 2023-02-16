import { useHotkeys } from '@mantine/hooks';

import Router, { useRouter } from 'next/router';
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';

import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { GalleryImageDetail } from '~/server/controllers/image.controller';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { QS } from '~/utils/qs';
import { trpc } from '~/utils/trpc';

type GalleryDetailProviderProps = {
  children: React.ReactNode;
};

type GalleryDetailState = {
  images: GalleryImageDetail[];
  image?: GalleryImageDetail;
  isLoading: boolean;
  active: boolean;
  modelId?: number;
  reviewId?: number;
  userId?: number;
  infinite?: boolean;
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

const GalleryDetailCtx = createContext<GalleryDetailState>({} as any);
export const useGalleryDetailContext = () => {
  const context = useContext(GalleryDetailCtx);
  if (!context)
    throw new Error('useGalleryDetailContext can only be used inside GalleryDetailProvider');
  return context;
};

export function GalleryDetailProvider({ children }: GalleryDetailProviderProps) {
  const router = useRouter();
  const closingRef = useRef(false);
  const hasHistory = useHasClientHistory();
  const currentUser = useCurrentUser();
  const { filters } = useGalleryFilters();
  const { modelId, reviewId, userId, infinite } = filters;

  const imageId = Number(router.query.galleryImageId);
  const active = router.query.active === 'true';

  // #region [data fetching]
  const { data: infiniteGallery, isLoading: infiniteLoading } =
    trpc.image.getGalleryImagesInfinite.useInfiniteQuery(filters, { enabled: filters.infinite });

  const { data: finiteGallery, isLoading: finiteLoading } = trpc.image.getGalleryImages.useQuery(
    filters,
    {
      enabled: !filters.infinite,
    }
  );
  const isLoading = filters.infinite ? infiniteLoading : finiteLoading;

  const images = useMemo(
    () => infiniteGallery?.pages.flatMap((x) => x.items) ?? finiteGallery ?? [],
    [infiniteGallery, finiteGallery]
  );

  // only allow this to run if the detail data isn't included in the list result
  const { data: prefetchedImage } = trpc.image.getGalleryImageDetail.useQuery(
    { id: imageId },
    { enabled: !images.some((x) => x.id === imageId) }
  );

  const image = images.find((x) => x.id === imageId) ?? prefetchedImage;
  // #endregion

  // #region [back button functionality]
  const close = () => {
    if (closingRef.current) return;
    const [, queryString] = router.asPath.split('?');
    const { active, ...query } = QS.parse(queryString) as any;
    if (active) {
      if (hasHistory) router.back();
      else router.replace({ query: router.query }, { query }, { shallow: true });
    } else {
      if (hasHistory) router.back();
      else
        router.push((router.query.returnUrl as string) ?? '/gallery', undefined, { shallow: true });
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
    Router.events.on('routeChangeStart', handleClosingStart);
    Router.events.on('routeChangeComplete', handleClosingEnd);

    return () => {
      Router.events.off('routeChangeStart', handleClosingStart);
      Router.events.off('routeChangeComplete', handleClosingEnd);
    };
  }, []);
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
    const { galleryImageId, ...query } = Router.query;
    const [, queryString] = Router.asPath.split('?');
    Router.replace(
      { query: { ...query, galleryImageId: id } },
      {
        pathname: `/gallery/${id}`,
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

  return (
    <GalleryDetailCtx.Provider
      value={{
        images,
        image,
        isLoading,
        active,
        toggleInfo,
        close,
        next,
        previous,
        infinite,
        modelId,
        reviewId,
        userId,
        isOwner,
        isMod,
        shareUrl,
        canNavigate,
        navigate,
      }}
    >
      {children}
    </GalleryDetailCtx.Provider>
  );
}
