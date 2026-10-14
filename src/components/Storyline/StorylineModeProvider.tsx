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
  parseStorylineChapterParam,
  STORYLINE_CHAPTER_PARAM,
} from '~/components/Storyline/storyline-mode.utils';
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
  const chapterId = parseStorylineChapterParam(browserRouter.query[STORYLINE_CHAPTER_PARAM]);

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

  return { chapterId, go };
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
  const { chapterId: routeChapterId, go } = useStorylineRoute();
  const chapterId = enabled ? routeChapterId : undefined;
  const tracking = useStorylineTracking();

  const pathQuery = useStorylinePath(chapterId);
  const path = pathQuery.data;
  const {
    images,
    isLoading: imagesLoading,
    isFetching: imagesFetching,
  } = useStorylinePathImages(path?.chapters);

  const [endOpen, setEndOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pendingChapterId, setPendingChapterId] = useState<number>();

  const walk = useMemo(
    () => getStorylineWalk(path?.chapters ?? [], images),
    [path?.chapters, images]
  );

  const enter = useCallback((id: number) => go({ chapterId: id }), [go]);
  const leave = useCallback(() => {
    setEndOpen(false);
    setDrawerOpen(false);
    go({ chapterId: undefined });
  }, [go]);

  const jumpToChapter = useCallback(
    (id: number) => {
      const imageId = walk.firstImageIdByChapterId.get(id);
      if (!imageId) return;
      setEndOpen(false);
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
    if (!pendingChapterId || pathEndId !== pendingChapterId || imagesFetching) return;
    setPendingChapterId(undefined);
    const imageId = walk.firstImageIdByChapterId.get(pendingChapterId);
    if (!imageId) return;
    setEndOpen(false);
    go({ imageId, chapterId: pendingChapterId });
  }, [pendingChapterId, pathEndId, imagesFetching, walk, go]);

  const value = useMemo<StorylineModeState>(() => {
    if (!chapterId || !path) return { active: false, enter };
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
  }, [chapterId, path, images, walk, enter, leave, jumpToChapter, continueTo, endOpen, drawerOpen]);

  if (chapterId && !path && pathQuery.isLoading) return <PageLoader />;
  if (value.active && imagesLoading && !images.length) return <PageLoader />;

  // A path whose every chapter is hidden from this reader has nothing to walk, so the detail
  // keeps the images it was opened with and the banner still offers the end-of-chapter view.
  const storylineImages = value.active && images.length ? images : undefined;

  return (
    <StorylineModeContext.Provider value={value}>
      {children(storylineImages, storylineImages ? `storyline-${chapterId}` : 'feed')}
    </StorylineModeContext.Provider>
  );
}
