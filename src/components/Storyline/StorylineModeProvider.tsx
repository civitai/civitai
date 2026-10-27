import Router from 'next/router';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useBrowserRouter } from '~/components/BrowserRouter/BrowserRouterProvider';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import type { StorylinePath } from '~/components/Storyline/storyline.queries';
import {
  useStorylinePath,
  useStorylinePathImages,
  useStorylinesEnabled,
  useStorylineTracking,
} from '~/components/Storyline/storyline.queries';
import {
  getStorylineWalk,
  hideHiddenUsersChapters,
  parseIdListParam,
  parseIdParam,
  resolvePendingContinue,
  routeVia,
  storylineChapterLink,
  STORYLINE_CHAPTER_PARAM,
  STORYLINE_VIA_PARAM,
} from '~/components/Storyline/storyline-mode.utils';
import { useHiddenUserIds } from '~/components/Storyline/storyline.queries';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { QS } from '~/utils/qs';

type InactiveState = { active: false; enter: (chapterId: number) => void };
type RouteStop = { chapterId: number; parentCount?: number };
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
  /**
   * The mode moving the detail to an image. The URL alone cannot: it trails the carousel until it
   * settles, so it may already name the image while another is on screen.
   */
  onSeek: (listener: (imageId: number) => void) => () => void;
  /**
   * Read on into another chapter. `from` is the chapter it continues, when that is not the end
   * of the path (a branch off an earlier stop), and `line` the reader's line it is on, the path by
   * default (the drawer passes the canon line ahead too; `[]` starts a fresh route). `track: false`
   * for a jump along the line, which is not a choice at a fork.
   */
  continueTo: (
    child: RouteStop,
    options?: { from?: number; track?: boolean; line?: RouteStop[] }
  ) => void;
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
  const viaParam = String(browserRouter.query[STORYLINE_VIA_PARAM] ?? '');
  const via = useMemo(() => parseIdListParam(viaParam), [viaParam]);

  const go = useCallback(
    ({
      imageId,
      chapterId,
      via = [],
    }: {
      imageId?: number;
      chapterId: number | undefined;
      via?: number[];
    }) => {
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
      if (chapterId && via.length) {
        query[STORYLINE_VIA_PARAM] = via.join(',');
        asQuery[STORYLINE_VIA_PARAM] = via.join(',');
      } else {
        delete query[STORYLINE_VIA_PARAM];
        delete asQuery[STORYLINE_VIA_PARAM];
      }
      if (imageId) query.imageId = imageId;
      browserRouter.replace(
        { query },
        { pathname: imageId ? `/images/${imageId}` : pathname, query: asQuery }
      );
    },
    [browserRouter]
  );

  return { chapterId, imageId, via, go };
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
  const { chapterId: routeChapterId, imageId: routeImageId, via, go } = useStorylineRoute();
  const chapterId = enabled ? routeChapterId : undefined;
  const tracking = useStorylineTracking();

  const pathQuery = useStorylinePath(chapterId, via);
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
  const [trusted, setTrusted] = useState<{ chapterId: number; imageId: number | undefined }>();

  const walk = useMemo(
    () => getStorylineWalk(path?.chapters ?? [], images),
    [path?.chapters, images]
  );

  const seekListeners = useRef(new Set<(imageId: number) => void>());
  const onSeek = useCallback((listener: (imageId: number) => void) => {
    seekListeners.current.add(listener);
    return () => void seekListeners.current.delete(listener);
  }, []);

  const enter = useCallback((id: number) => go({ chapterId: id }), [go]);
  const leave = useCallback(() => {
    setEndOpenFor(undefined);
    setDrawerOpen(false);
    setTrusted(undefined);
    go({ chapterId: undefined });
  }, [go]);

  const jumpToChapter = useCallback(
    (id: number) => {
      const imageId = walk.firstImageIdByChapterId.get(id);
      if (!imageId) {
        // Not in the walk (its images still paging in, or past the cap): a click must still land,
        // so open the chapter from its own link.
        const chapters = path?.chapters ?? [];
        const at = chapters.findIndex((chapter) => chapter.chapterId === id);
        const link =
          at >= 0 && storylineChapterLink(chapters[at], routeVia(chapters.slice(0, at + 1)));
        if (link) Router.push(link.href);
        return;
      }
      setEndOpenFor(undefined);
      setDrawerOpen(false);
      go({ imageId, chapterId, via });
      seekListeners.current.forEach((listener) => listener(imageId));
    },
    [walk, go, chapterId, via, path?.chapters]
  );

  const continueTo = useCallback(
    (
      child: RouteStop,
      {
        from = chapterId,
        track = true,
        line = path?.chapters ?? [],
      }: { from?: number; track?: boolean; line?: RouteStop[] } = {}
    ) => {
      if (from && track)
        tracking.trackBranchChoice({ fromChapterId: from, toChapterId: child.chapterId });
      const before = line.slice(0, line.findIndex((stop) => stop.chapterId === from) + 1);
      setDrawerOpen(false);
      setTrusted({ chapterId: child.chapterId, imageId: routeImageId });
      setPendingChapterId(child.chapterId);
      go({ chapterId: child.chapterId, via: routeVia([...before, child]) });
    },
    [chapterId, path?.chapters, routeImageId, go, tracking]
  );

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
    if (routeImageId !== next.imageId)
      go({ imageId: next.imageId, chapterId: pendingChapterId, via });
  }, [pendingChapterId, chapterId, pathEndId, imagesFetching, walk, go, routeImageId, via]);

  // The URL's chapter is trusted only for an image on its own path (not the previous chapter's,
  // still shown while this one loads), or for the image a reader was on when they took the
  // branch from inside the storyline: a link pairing an image with an unrelated storyline must
  // not put that image under the storyline's banner.
  const onPath =
    pathEndId === chapterId && !!routeImageId && walk.chapterIdByImageId.has(routeImageId);
  const tookBranchHere = trusted?.chapterId === chapterId && trusted?.imageId === routeImageId;
  const inStoryline = !!chapterId && !!path && (onPath || tookBranchHere);

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
      onSeek,
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
    onSeek,
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
