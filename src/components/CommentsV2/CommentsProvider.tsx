import type { MantineColor } from '@mantine/core';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useRouter } from 'next/router';
import { parseNumericString } from '~/utils/query-string-helpers';
import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import type { ReplyThread } from '~/server/services/commentsv2.reply-threads';
import { ThreadSort } from '../../server/common/enums';
import { constants } from '~/server/common/constants';
import { RETURN_TO_ROOT_THREAD_ID } from '~/components/CommentsV2/commentv2.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export type CommentV2BadgeProps = {
  userId: number;
  color: MantineColor;
  label: string;
};

type RootEntity = Pick<CommentConnectorInput, 'entityType' | 'entityId'>;

type Props = CommentConnectorInput & {
  initialCount?: number;
  limit?: number;
  badges?: CommentV2BadgeProps[];
  hidden?: boolean;
  children: (args: ChildProps) => React.ReactNode;
  forceLocked?: boolean;
  hideWhenLocked?: boolean;
  level?: number;
};

type ChildProps = {
  data?: CommentV2Model[];
  isLoading: boolean;
  isFetching: boolean;
  isFetchingNextPage: boolean;
  isLocked: boolean;
  isMuted: boolean;
  isReadonly: boolean;
  created: CommentV2Model[];
  badges?: CommentV2BadgeProps[];
  limit?: number;
  remaining?: number;
  showMore: boolean;
  toggleShowMore: () => void;
  highlighted?: number;
  hiddenCount: number;
  forceLocked?: boolean;
  sort: ThreadSort;
  setSort: (sort: ThreadSort) => void;
  activeComment?: CommentV2Model;
};

type RootThreadContext = {
  sort: ThreadSort;
  setSort: (sort: ThreadSort) => void;
  isInitialThread: boolean;
  setInitialThread: () => void;
  setRootThread: (entityType: CommentConnectorInput['entityType'], entityId: number) => void;
  setExpanded: (commentId: number, expanded: boolean) => void;
  activeComment?: CommentV2Model;
  /**
   * The surface the section belongs to. Every nested thread reports its own entity type as
   * `comment`, so per-surface thread settings have to be resolved against this instead.
   */
  rootEntityType: CommentConnectorInput['entityType'];
};

export const RootThreadCtx = createContext<RootThreadContext>({} as any);
export const useRootThreadContext = () => {
  const context = useContext(RootThreadCtx);
  if (!context) throw new Error('useRootThreadContext can only be used inside RootThreadProvider');
  return context;
};

/**
 * Reply trees a page fetched alongside its own comments. A nested thread reads its first page and
 * its counts from here rather than asking for them, so a whole conversation costs one request per
 * page instead of one per comment per level — and whether a thread renders open follows from what
 * this holds, so nothing has to be written anywhere to open it.
 */
type SeededReplyThreads = {
  byCommentId: Map<number, ReplyThread>;
  /** Comments the batch confirmed have no replies at all, over the levels it finished. */
  childless: Set<number>;
};

const emptySeededThreads: SeededReplyThreads = { byCommentId: new Map(), childless: new Set() };
const SeededReplyThreadsCtx = createContext<SeededReplyThreads>(emptySeededThreads);
export const useSeededReplyThreads = () => useContext(SeededReplyThreadsCtx);

export function RootThreadProvider({
  entityType: initialEntityType,
  entityId: initialEntityId,
  hidden,
  ...props
}: Props) {
  const router = useRouter();
  const [sort, setSort] = useState<ThreadSort>(ThreadSort.Oldest);
  const setExpanded = useNewCommentStore((state) => state.setExpanded);

  const queryType = router.query.commentParentType as
    | CommentConnectorInput['entityType']
    | undefined;
  const queryId = parseNumericString(router.query.commentParentId);
  const linkedThread: RootEntity | undefined =
    queryType && queryId ? { entityType: queryType, entityId: queryId } : undefined;

  // A deep-link decides where the section starts; opening a thread from inside it is an override on
  // top of that. Deriving rather than syncing keeps a second deep-link working — arriving at a
  // different one changes the key below, which drops the override exactly as a remount would.
  const rootKey = `${initialEntityType}_${initialEntityId}_${queryType ?? ''}_${queryId ?? ''}`;
  const [state, setState] = useState<{ rootKey: string; override?: RootEntity }>({ rootKey });
  if (state.rootKey !== rootKey) setState({ rootKey });
  const override = state.rootKey === rootKey ? state.override : undefined;

  const entity = override ??
    linkedThread ?? { entityType: initialEntityType, entityId: initialEntityId };

  const isInitialThread =
    entity.entityId === initialEntityId && entity.entityType === initialEntityType;

  const { data: activeComment } = trpc.commentv2.getSingle.useQuery(
    { id: entity.entityId },
    { enabled: !isInitialThread }
  );

  const setRootThread = useCallback(
    (entityType: CommentConnectorInput['entityType'], entityId: number) =>
      setState((current) => ({ ...current, override: { entityType, entityId } })),
    []
  );

  const setInitialThread = useCallback(
    () =>
      setState((current) => ({
        ...current,
        override: { entityType: initialEntityType, entityId: initialEntityId },
      })),
    [initialEntityType, initialEntityId]
  );

  const value = useMemo(
    () => ({
      sort,
      setSort,
      setRootThread,
      setInitialThread,
      isInitialThread,
      setExpanded,
      activeComment,
      rootEntityType: initialEntityType,
    }),
    [
      sort,
      setRootThread,
      setInitialThread,
      isInitialThread,
      setExpanded,
      activeComment,
      initialEntityType,
    ]
  );

  return (
    <RootThreadCtx.Provider value={value}>
      <CommentsProvider
        entityType={entity.entityType}
        entityId={entity.entityId}
        hidden={hidden}
        level={1}
        {...props}
      />
    </RootThreadCtx.Provider>
  );
}

type CommentsContext = CommentConnectorInput &
  ChildProps & {
    level?: number;
  };

export const CommentsCtx = createContext<CommentsContext>({} as any);
export const useCommentsContext = () => {
  const context = useContext(CommentsCtx);
  if (!context) throw new Error('useCommentsContext can only be used inside CommentsProvider');
  return context;
};

export function CommentsProvider({
  entityType,
  entityId,
  children,
  initialCount,
  limit: initialLimit = 5,
  badges,
  hidden,
  forceLocked,
  hideWhenLocked,
  level = 1,
}: Props) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { sort, setSort, activeComment, rootEntityType, isInitialThread } = useRootThreadContext();
  const storeKey = getKey(entityType, entityId);
  const created = useNewCommentStore(
    useCallback((state) => state.comments[storeKey] ?? emptyComments, [storeKey])
  );

  // A nested thread the page above already fetched. Passed to the queries below as initial data,
  // which — unlike writing it into the cache — lands on whatever key each query actually uses.
  const inheritedThread = useSeededReplyThreads().byCommentId.get(entityId);
  const seeded = entityType === 'comment' ? inheritedThread : undefined;

  const { data: threadDetails } = trpc.commentv2.getThreadDetails.useQuery(
    { entityId, entityType },
    seeded
      ? { initialData: { id: seeded.id, locked: seeded.locked, hiddenCount: seeded.hiddenCount } }
      : undefined
  );

  // Notification deep-links pass ?highlight=<commentId>. Forward it to the server so the
  // target comment is included in the first page even when it would otherwise be past the
  // cursor — otherwise the highlight scroll never fires.
  const highlighted = parseNumericString(router.query.highlight);

  const maxDepth = constants.comments.getMaxDepth({ entityType: rootEntityType });
  // Reply trees ride along with the page that owns them, so a surface that shows threads open
  // costs one request per page instead of one per comment per level. Levels past this stay
  // collapsed on their own: nothing seeds them, and an unseeded thread renders closed.
  const autoExpandDepth = constants.comments.getAutoExpandDepth({ entityType: rootEntityType });
  const repliesDepth = level === 1 && !hidden && autoExpandDepth > 0 ? autoExpandDepth : undefined;
  const replyPageSize = constants.comments.replyPageSize;

  const { data, isLoading, isRefetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.commentv2.getInfinite.useInfiniteQuery(
      {
        entityId,
        entityType,
        limit: initialLimit,
        sort,
        hidden: hidden ?? false,
        targetCommentId: highlighted,
        repliesDepth,
        repliesLimit: replyPageSize,
      },
      {
        enabled: initialCount === undefined || initialCount > 0,
        getNextPageParam: (lastPage) => lastPage?.nextCursor,
        initialData: seeded
          ? {
              pages: [
                {
                  comments: seeded.comments,
                  nextCursor: seeded.nextCursor,
                  targetComment: null,
                  replyThreads: [],
                  childlessCommentIds: [],
                },
              ],
              pageParams: [undefined],
            }
          : undefined,
      }
    );

  const seededReplyThreads = useMemo(() => {
    if (!repliesDepth) return emptySeededThreads;
    const byCommentId = new Map<number, ReplyThread>();
    const childless = new Set<number>();
    for (const page of data?.pages ?? []) {
      for (const thread of page?.replyThreads ?? []) byCommentId.set(thread.commentId, thread);
      for (const id of page?.childlessCommentIds ?? []) childless.add(id);
    }
    return { byCommentId, childless };
  }, [data, repliesDepth]);

  // Flatten pages, prepending the deep-link target (when present) and deduping by id so a
  // later cursor page that naturally contains the target doesn't render it twice.
  const comments = useMemo(() => {
    if (!data) return [] as CommentV2Model[];
    const seen = new Set<number>();
    const result: CommentV2Model[] = [];
    const target = data.pages[0]?.targetComment;
    if (target) {
      seen.add(target.id);
      result.push(target);
    }
    for (const page of data.pages) {
      for (const c of page?.comments ?? []) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        result.push(c);
      }
    }
    return result;
  }, [data]);

  // Opening a thread replaces the whole section, which collapses the page under the reader and
  // leaves them somewhere they never asked to be. Put them at the comment they opened, once the
  // thread has actually rendered — surfaces show a loader in its place until then, and child
  // effects run before this one, so the element is in the DOM by the time this fires.
  // `scrollIntoView` rather than window scrolling: the app scrolls an inner container.
  const activeCommentId = activeComment?.id;
  const threadSettled = !isLoading && !isRefetching;
  useEffect(() => {
    if (level !== 1 || isInitialThread || !activeCommentId || !threadSettled) return;
    // Prefer the way back out: landing on the comment itself scrolls that link off the top, and
    // how far above it sits differs per surface, so aiming at it beats guessing an offset.
    const el =
      document.getElementById(RETURN_TO_ROOT_THREAD_ID) ??
      document.getElementById(`comment-${activeCommentId}`);
    if (!el) return;
    el.style.scrollMarginTop = '16px';
    el.scrollIntoView({ block: 'start' });
  }, [level, isInitialThread, activeCommentId, threadSettled]);

  const hiddenCount = threadDetails?.hiddenCount ?? 0;

  const createdComments = useMemo(
    () => created.filter((x) => !comments?.some((comment) => comment.id === x.id)),
    [created, comments]
  );

  const isLocked = threadDetails?.locked ?? false;
  const isReadonly = !features.canWrite;
  const isMuted = currentUser?.muted ?? false;
  const shouldHideComments = hideWhenLocked && isLocked;

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const childProps: ChildProps = {
    data: shouldHideComments ? [] : comments,
    isLoading,
    isFetching: isRefetching,
    isFetchingNextPage,
    isLocked,
    isMuted,
    isReadonly,
    created: shouldHideComments ? [] : createdComments,
    badges,
    limit: initialLimit,
    showMore: shouldHideComments ? false : hasNextPage ?? false,
    toggleShowMore: loadMore,
    highlighted,
    hiddenCount,
    forceLocked,
    sort,
    setSort,
    activeComment,
  };

  const threadId = threadDetails?.id;
  const value = useMemo<CommentsContext>(
    () => ({
      data: shouldHideComments ? [] : comments,
      isLoading,
      isFetching: isRefetching,
      isFetchingNextPage,
      entityId,
      entityType,
      isLocked,
      isMuted,
      isReadonly,
      created: shouldHideComments ? [] : created,
      badges,
      limit: initialLimit,
      showMore: shouldHideComments ? false : hasNextPage ?? false,
      toggleShowMore: loadMore,
      highlighted,
      hiddenCount,
      forceLocked,
      sort,
      setSort,
      parentThreadId: threadId,
      level,
    }),
    [
      shouldHideComments,
      comments,
      isLoading,
      isRefetching,
      isFetchingNextPage,
      entityId,
      entityType,
      isLocked,
      isMuted,
      isReadonly,
      created,
      badges,
      initialLimit,
      hasNextPage,
      loadMore,
      highlighted,
      hiddenCount,
      forceLocked,
      sort,
      setSort,
      threadId,
      level,
    ]
  );

  const section = <CommentsCtx.Provider value={value}>{children(childProps)}</CommentsCtx.Provider>;

  // Only the page that fetched the reply trees publishes them. A nested thread must keep reading
  // its parent's, or it would shadow the map its own children need.
  return repliesDepth ? (
    <SeededReplyThreadsCtx.Provider value={seededReplyThreads}>
      {section}
    </SeededReplyThreadsCtx.Provider>
  ) : (
    section
  );
}

/**
 * When adding comments to an infinite list, new comments are displayed in the ui at the bottom of the list.
 * It's important to recognize that our infinite list may only be displaying a partial list (user needs to 'load more'), and new
 * comments will appear below the partial list.
 *
 * If a user were to click 'load more' and the action were to retrieve the comment the user just created,
 * we would no longer need to display the new comment at the end of the list
 *
 * We use a zustand store because the above mentioned functionality is difficult to achieve using solely the react-query cache
 */

type StoreProps = {
  /** dictionary of [entityType_entityId]: [...comments] */
  comments: Record<string, CommentV2Model[]>;
  /** The reader's own open/closed choice. No entry means the surface's default stands. */
  expandOverrides: Record<number, boolean>;
  setExpanded: (commentId: number, expanded: boolean) => void;
  addComment: (entityType: string, entityId: number, comment: CommentV2Model) => void;
  editComment: (entityType: string, entityId: number, comment: CommentV2Model) => void;
  deleteComment: (entityType: string, entityId: number, commentId: number) => void;
};

const emptyComments: CommentV2Model[] = [];

const getKey = (entityType: string, entityId: number) => `${entityId}_${entityType}`;

export const useNewCommentStore = create<StoreProps>()(
  immer((set) => {
    return {
      comments: {},
      expandOverrides: {},
      setExpanded: (commentId: number, expanded: boolean) =>
        set((state) => {
          state.expandOverrides[commentId] = expanded;
        }),
      addComment: (entityType, entityId, comment) =>
        set((state) => {
          const key = getKey(entityType, entityId);
          if (!state.comments[key]?.length) state.comments[key] = [comment];
          else state.comments[key].push(comment);
        }),
      editComment: (entityType, entityId, comment) =>
        set((state) => {
          const key = getKey(entityType, entityId);
          if (!state.comments[key]) {
            return;
          }
          const index = state.comments[key].findIndex((x) => x.id === comment.id);
          if (index > -1) state.comments[key][index].content = comment.content;
        }),
      deleteComment: (entityType, entityId, commentId) =>
        set((state) => {
          const key = getKey(entityType, entityId);
          if (!state.comments[key]) {
            return;
          }

          state.comments[key] = state.comments[key].filter((x) => x.id !== commentId);
        }),
    };
  })
);
