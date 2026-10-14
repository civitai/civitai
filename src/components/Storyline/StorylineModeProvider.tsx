import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import type { StorylineChild, StorylinePath } from '~/components/Storyline/storyline.queries';
import {
  useStorylinePath,
  useStorylinePathImages,
  useStorylinesEnabled,
  useStorylineTracking,
} from '~/components/Storyline/storyline.queries';
import {
  getStorylineWalk,
  hideHiddenUsersChapters,
  parseIdParam,
  resolvePendingContinue,
  STORYLINE_CHAPTER_PARAM,
} from '~/components/Storyline/storyline-mode.utils';
import { useHiddenUserIds } from '~/components/Storyline/storyline.queries';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { QS } from '~/utils/qs';

type InactiveState = { active: false; enter: (chapterId: number) => void };
export type ActiveStorylineMode = {
  active: true;
  enter: (chapterId: number) => void;
  leave: () => void;
  /** The last chapter of the path being read; the end-of-chapter view continues from here. */
  chapterId: number;
  path: StorylinePath;
  images: ImagesInfiniteModel[];
  chapterIdOfImage: (imageId: number) => number | undefined;
  jumpToChapter: (chapterId: number) => void;
  continueTo: (child: Pick<StorylineChild, 'chapterId'>) => void;
  endOpen: boolean;
  setEndOpen: (open: boolean) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
};
type StorylineModeState = InactiveState | ActiveStorylineMode;

const StorylineModeContext = createContext<StorylineModeState | null>(null);

const noop = () => undefined;
const OUTSIDE: InactiveState = { active: false, enter: noop };

/** Outside a provider (any surface but image detail) storyline mode is simply off. */
export function useStorylineMode(): StorylineModeState {
  return useContext(StorylineModeContext) ?? OUTSIDE;
}

function useStorylineRoute() {
  const browserRouter = useBrowserRouter();
  const chapterId = parseIdParam(browserRouter.query[STORYLINE_CHAPTER_PARAM]);
  const imageId = parseIdParam(browserRouter.query.imageId);

  const go = useCallback(
    ({ imageId, chapterId }: { imageId?: number; chapterId: number | undefined }) => {
      const [pathname, queryString] = browserRouter.asPath.split('?');
      const asQuery = QS.parse(queryString) as Record<string, string | number>;
      const query: Record<string, string | number> = { ...browserRouter.query };
      if (chapterId) {
        query[STORYLINE_CHAPTER_PARAM] = chapterId;
        asQuery[STORYLINE_CHAPTER_PARAM] = chapterId;
      } else {
        delete query[STORYLINE_CHAPTER_PARAM];
        delete asQuery[STORYLINE_CHAPTER_PARAM];
      }
      if (imageId) query.imageId = imageId;
      browserRouter.replace(
        { query },
        { pathname: imageId ? `/images/${imageId}` : pathname, query: asQuery }
      );
    },
    [browserRouter]
  );

  return { chapterId, imageId, go };
}

/**
 * Wraps image detail. While the URL names a storyline chapter, the detail is handed that path's
 * images in reading order instead of the feed's, so left and right walk the story.
 */
export function StorylineModeProvider({
  children,
}: {
  /**
   * `modeKey` changes whenever the walked list is replaced (entering, leaving, taking another
   * branch). Key the detail on it: the carousel's index and loop are read at mount.
   */
  children: (
    storylineImages: ImagesInfiniteModel[] | undefined,
    modeKey: string
  ) => React.ReactNode;
}) {
  const enabled = useStorylinesEnabled();
  const { chapterId: routeChapterId, imageId: routeImageId, go } = useStorylineRoute();
  const chapterId = enabled ? routeChapterId : undefined;
  const tracking = useStorylineTracking();

  const pathQuery = useStorylinePath(chapterId);
  const hiddenUserIds = useHiddenUserIds();
  const path = useMemo(
    () =>
      pathQuery.data && {
        ...pathQuery.data,
        chapters: hideHiddenUsersChapters(pathQuery.data.chapters, hiddenUserIds),
      },
    [pathQuery.data, hiddenUserIds]
  );
  const {
    images,
    isLoading: imagesLoading,
    isFetching: imagesFetching,
  } = useStorylinePathImages(path?.chapters);

  // The end view and the trust below belong to the chapter that set them, so neither survives
  // the URL moving to another chapter by any route but taking a branch.
  const [endOpenFor, setEndOpenFor] = useState<number>();
  const endOpen = !!chapterId && endOpenFor === chapterId;
  const setEndOpen = useCallback(
    (open: boolean) => setEndOpenFor(open ? chapterId : undefined),
    [chapterId]
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingChapterId, setPendingChapterId] = useState<number>();
  const [trustedChapterId, setTrustedChapterId] = useState<number>();

  const walk = useMemo(
    () => getStorylineWalk(path?.chapters ?? [], images),
    [path?.chapters, images]
  );

  const enter = useCallback((id: number) => go({ chapterId: id }), [go]);
  const leave = useCallback(() => {
    setEndOpenFor(undefined);
    setDrawerOpen(false);
    go({ chapterId: undefined });
  }, [go]);

  const jumpToChapter = useCallback(
    (id: number) => {
      const imageId = walk.firstImageIdByChapterId.get(id);
      if (!imageId) return;
      setEndOpenFor(undefined);
      setDrawerOpen(false);
      go({ imageId, chapterId });
    },
    [walk, go, chapterId]
  );

  const continueTo = useCallback(
    (child: Pick<StorylineChild, 'chapterId'>) => {
      if (chapterId)
        tracking.trackBranchChoice({ fromChapterId: chapterId, toChapterId: child.chapterId });
      setDrawerOpen(false);
      setTrustedChapterId(child.chapterId);
      setPendingChapterId(child.chapterId);
      go({ chapterId: child.chapterId });
    },
    [chapterId, go, tracking]
  );

  // Once the chosen chapter's path and images arrive, open its first image. A chapter with no
  // image this reader can see leaves the end-of-chapter view open on it, so what follows a
  // hidden chapter stays reachable.
  const pathEndId = path?.chapters[path.chapters.length - 1]?.chapterId;
  useEffect(() => {
    if (!pendingChapterId) return;
    if (pendingChapterId !== chapterId) return setPendingChapterId(undefined);
    const next = resolvePendingContinue({
      pendingChapterId,
      pathEndId,
      imagesFetching,
      firstImageIdByChapterId: walk.firstImageIdByChapterId,
    });
    if (next.kind === 'wait') return;
    setPendingChapterId(undefined);
    if (next.kind === 'end') return setEndOpenFor(pendingChapterId);
    setEndOpenFor(undefined);
    // The router updates synchronously and re-runs this before the cleared state lands; only
    // navigate once, or the two chase each other.
    if (routeImageId !== next.imageId) go({ imageId: next.imageId, chapterId: pendingChapterId });
  }, [pendingChapterId, chapterId, pathEndId, imagesFetching, walk, go, routeImageId]);

  // The URL's chapter is trusted only for an image on its path, or for a branch the reader took
  // from inside the storyline: a link pairing an image with an unrelated storyline must not put
  // that image under the storyline's banner.
  const onPath = !!routeImageId && walk.chapterIdByImageId.has(routeImageId);
  useEffect(() => {
    if (onPath && chapterId) setTrustedChapterId(chapterId);
  }, [onPath, chapterId]);
  const inStoryline = !!chapterId && !!path && (onPath || trustedChapterId === chapterId);

  const value = useMemo<StorylineModeState>(() => {
    if (!chapterId || !path || !inStoryline) return { active: false, enter };
    return {
      active: true,
      enter,
      leave,
      chapterId,
      path,
      images,
      chapterIdOfImage: (imageId) => walk.chapterIdByImageId.get(imageId),
      jumpToChapter,
      continueTo,
      endOpen,
      setEndOpen,
      drawerOpen,
      setDrawerOpen,
    };
  }, [
    chapterId,
    path,
    inStoryline,
    images,
    walk,
    enter,
    leave,
    jumpToChapter,
    continueTo,
    endOpen,
    drawerOpen,
  ]);

  if (chapterId && !pathQuery.data && pathQuery.isLoading) return <PageLoader />;
  if (chapterId && path && imagesLoading && !images.length) return <PageLoader />;

  const storylineImages = value.active && images.length ? images : undefined;

  return (
    <StorylineModeContext.Provider value={value}>
      {children(storylineImages, storylineImages ? `storyline-${chapterId}` : 'feed')}
    </StorylineModeContext.Provider>
  );
}
