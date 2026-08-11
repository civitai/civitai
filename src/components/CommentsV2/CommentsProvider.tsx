import type { MantineColor } from '@mantine/core';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useRouter } from 'next/router';
import { parseNumericString } from '~/utils/query-string-helpers';
import type { CommentV2Model } from '~/server/selectors/commentv2.selector';
import { ThreadSort } from '../../server/common/enums';
import { constants } from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export type CommentV2BadgeProps = {
  userId: number;
  color: MantineColor;
  label: string;
};

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
  expanded: number[];
  toggleExpanded: (commentId: number) => void;
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

export function RootThreadProvider({
  entityType: initialEntityType,
  entityId: initialEntityId,
  hidden,
  ...props
}: Props) {
  const router = useRouter();
  const [entity, setEntity] = useState({
    entityType: initialEntityType,
    entityId: initialEntityId,
  });
  const [sort, setSort] = useState<ThreadSort>(ThreadSort.Oldest);
  const expanded = useNewCommentStore((state) => state.expandedComments);
  const toggleExpanded = useNewCommentStore((state) => state.toggleExpanded);
  const isInitialThread =
    entity.entityId === initialEntityId && entity.entityType === initialEntityType;
  const queryType = router.query.commentParentType as CommentConnectorInput['entityType'];
  const queryId = parseNumericString(router.query.commentParentId);

  const { data: activeComment } = trpc.commentv2.getSingle.useQuery(
    { id: entity.entityId },
    { enabled: !isInitialThread }
  );

  const setRootThread = useCallback(
    (entityType: CommentConnectorInput['entityType'], entityId: number) => {
      setEntity({
        entityType,
        entityId,
      });
    },
    []
  );

  const setInitialThread = useCallback(() => {
    setEntity({
      entityType: initialEntityType,
      entityId: initialEntityId,
    });
  }, [initialEntityType, initialEntityId]);

  useEffect(() => {
    if (queryType && queryId) {
      setRootThread(queryType, queryId);
    }
  }, [queryType, queryId]);

  return (
    <RootThreadCtx.Provider
      value={{
        sort,
        setSort,
        expanded,
        setRootThread,
        setInitialThread,
        isInitialThread,
        toggleExpanded,
        activeComment,
        rootEntityType: initialEntityType,
      }}
    >
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
  const utils = trpc.useUtils();
  const { sort, setSort, activeComment, rootEntityType } = useRootThreadContext();
  const setExpanded = useNewCommentStore((state) => state.setExpanded);
  const autoExpanded = useRef(new Set<number>());
  const storeKey = getKey(entityType, entityId);
  const created = useNewCommentStore(
    useCallback((state) => state.comments[storeKey] ?? [], [storeKey])
  );

  // Fetch thread metadata separately (only metadata, no comments)
  const { data: threadDetails } = trpc.commentv2.getThreadDetails.useQuery({
    entityId,
    entityType,
  });

  // Notification deep-links pass ?highlight=<commentId>. Forward it to the server so the
  // target comment is included in the first page even when it would otherwise be past the
  // cursor — otherwise the highlight scroll never fires.
  const highlighted = parseNumericString(router.query.highlight);

  const maxDepth = constants.comments.getMaxDepth({ entityType: rootEntityType });
  // Reply trees ride along with the page that owns them, so a surface that shows every thread
  // open costs one request per page instead of one per comment per level.
  const repliesDepth =
    level === 1 &&
    !hidden &&
    constants.comments.expandsRepliesByDefault({ entityType: rootEntityType })
      ? maxDepth - 1
      : undefined;
  const replyPageSize = constants.comments.replyPageSize;

  // Use infinite query with cursor-based pagination for comments
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
      }
    );

  const replyThreads = useMemo(
    () => data?.pages.flatMap((page) => page?.replyThreads ?? []) ?? [],
    [data]
  );

  // Seed each nested thread's caches from the batch above and open it, so the whole
  // conversation renders at once rather than a thread at a time behind "show replies".
  useEffect(() => {
    if (!replyThreads.length) return;

    const expandable: number[] = [];
    const withReplies = new Set(replyThreads.map((thread) => thread.commentId));

    for (const thread of replyThreads) {
      utils.commentv2.getCount.setData(
        { entityId: thread.commentId, entityType: 'comment' },
        thread.commentCount
      );
      utils.commentv2.getThreadDetails.setData(
        { entityId: thread.commentId, entityType: 'comment' },
        { id: thread.id, locked: thread.locked, hiddenCount: thread.hiddenCount }
      );
      utils.commentv2.getInfinite.setInfiniteData(
        {
          entityId: thread.commentId,
          entityType: 'comment',
          limit: replyPageSize,
          sort,
          hidden: false,
          repliesLimit: replyPageSize,
        },
        {
          pages: [
            {
              comments: thread.comments,
              nextCursor: thread.nextCursor,
              targetComment: null,
              replyThreads: [],
            },
          ],
          pageParams: [null],
        }
      );
      // A thread's depth is the level of the comment that owns it. Open each thread once, so
      // loading another page doesn't re-open what the reader has since collapsed.
      if (thread.depth < maxDepth && !autoExpanded.current.has(thread.commentId)) {
        autoExpanded.current.add(thread.commentId);
        expandable.push(thread.commentId);
      }
    }

    // A comment the batch reached but returned no thread for has no replies. Say so, rather
    // than leaving every childless comment to ask for its own count. The deepest level is
    // past what the batch looked at, so its counts are still unknown and must be fetched.
    const childless = [
      ...(data?.pages ?? []).flatMap((page) => page?.comments ?? []).map((c) => c.id),
      ...replyThreads
        .filter((thread) => thread.depth + 1 < maxDepth)
        .flatMap((thread) => thread.comments.map((c) => c.id)),
    ].filter((id) => !withReplies.has(id));

    for (const id of childless) {
      utils.commentv2.getCount.setData({ entityId: id, entityType: 'comment' }, 0);
    }

    setExpanded(expandable);
  }, [data, replyThreads, maxDepth, replyPageSize, sort, setExpanded, utils]);

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

  // Get thread metadata from dedicated query (includes locked status and hiddenCount)
  const threadMeta = threadDetails;
  const hiddenCount = threadMeta?.hiddenCount ?? 0;

  const createdComments = useMemo(
    () => created.filter((x) => !comments?.some((comment) => comment.id === x.id)),
    [created, comments]
  );

  const isLocked = threadMeta?.locked ?? false;
  const isReadonly = !features.canWrite;
  const isMuted = currentUser?.muted ?? false;
  const shouldHideComments = hideWhenLocked && isLocked;

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <CommentsCtx.Provider
      value={{
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
        parentThreadId: threadMeta?.id,
        level,
      }}
    >
      {children({
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
      })}
    </CommentsCtx.Provider>
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
  expandedComments: number[];
  setExpanded: (commentIds: number[]) => void;
  toggleExpanded: (commentId: number) => void;
  addComment: (entityType: string, entityId: number, comment: CommentV2Model) => void;
  editComment: (entityType: string, entityId: number, comment: CommentV2Model) => void;
  deleteComment: (entityType: string, entityId: number, commentId: number) => void;
};

const getKey = (entityType: string, entityId: number) => `${entityId}_${entityType}`;

export const useNewCommentStore = create<StoreProps>()(
  immer((set) => {
    return {
      comments: {},
      expandedComments: [],
      setExpanded: (commentIds: number[]) =>
        set((state) => {
          state.expandedComments = [...new Set([...state.expandedComments, ...commentIds])];
        }),
      toggleExpanded: (commentId: number) =>
        set((state) => {
          if (state.expandedComments.includes(commentId)) {
            state.expandedComments = state.expandedComments.filter((x) => x !== commentId);
          } else {
            state.expandedComments.push(commentId);
          }
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
