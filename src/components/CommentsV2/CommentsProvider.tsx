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
import { ThreadSort } from '../../server/common/enums';
import { isDefined } from '~/utils/type-guards';
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
  level?: number;
};

type ChildProps = {
  data?: CommentV2Model[];
  isLoading: boolean;
  isFetching: boolean;
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
};

const RootThreadCtx = createContext<RootThreadContext>({} as any);
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
  const setExpanded = useNewCommentStore((state) => state.setExpanded);
  const utils = trpc.useUtils();
  const isInitialThread =
    entity.entityId === initialEntityId && entity.entityType === initialEntityType;
  const queryType = router.query.commentParentType as CommentConnectorInput['entityType'];
  const queryId = parseNumericString(router.query.commentParentId);

  const { data: activeComment, isLoading } = trpc.commentv2.getSingle.useQuery(
    {
      id: entity.entityId,
    },
    {
      enabled: !isInitialThread,
    }
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
  }, []);

  // Load this main thread first, so we can fill our child threads. It will be loaded anyway by the provider, so no harm really.
  const { data: thread } = trpc.commentv2.getThreadDetails.useQuery(
    { entityId: entity.entityId, entityType: entity.entityType, hidden },
    {
      onSuccess: (data) => {
        if (!data) return;
        const allThreads = [data, ...(data.children ?? [])];
        const maxDepth = constants.comments.getMaxDepth({ entityType: entity.entityType });

        // Set expanded immediately (needed for UI)
        const expandedCommentIds =
          data?.children
            ?.filter((c) => c.depth < maxDepth)
            .map((c) => c.commentId)
            .filter(isDefined) ?? [];
        setExpanded(expandedCommentIds);

        // Defer cache operations to next tick to prevent main thread blocking
        setTimeout(() => {
          for (const thread of allThreads) {
            for (const comment of thread.comments ?? []) {
              const childThread = allThreads.find((x) => x.commentId === comment.id) ?? null;
              const childThreadDepth = childThread?.depth ?? 0;
              if (childThreadDepth < maxDepth) {
                utils.commentv2.getThreadDetails.setData(
                  {
                    entityId: comment.id,
                    entityType: 'comment',
                    hidden,
                  },
                  childThread
                );
              }

              utils.commentv2.getCount.setData(
                { entityId: comment.id, entityType: 'comment' },
                childThread?.count ?? 0
              );
            }
          }
        }, 0);
      },
    }
  );

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

const CommentsCtx = createContext<CommentsContext>({} as any);
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
  level = 1,
}: Props) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { sort, setSort, activeComment } = useRootThreadContext();
  const storeKey = getKey(entityType, entityId);
  const created = useNewCommentStore(
    useCallback((state) => state.comments[storeKey] ?? [], [storeKey])
  );

  const [showMore, setShowMore] = useState(false);
  const toggleShowMore = () => setShowMore((b) => !b);

  const {
    data: thread,
    isInitialLoading: isLoading,
    isFetching,
  } = trpc.commentv2.getThreadDetails.useQuery(
    { entityId, entityType, hidden },
    {
      enabled: initialCount === undefined || initialCount > 0,
      onSuccess: (data) => {
        setLimit(getLimit(data?.comments));
      },
    }
  );
  const hiddenCount = thread?.hidden ?? 0;

  const highlighted = parseNumericString(router.query.highlight);
  const getLimit = (data: { id: number }[] = []) => {
    if (highlighted !== undefined) {
      const limit = data.findIndex((x) => x.id === highlighted) + 1;
      return limit < initialLimit ? initialLimit : limit;
    }

    return initialLimit;
  };

  // Initialize limit state
  const [limit, setLimit] = useState(() => getLimit(thread?.comments ?? []));

  // Optimized: Single-pass sorting combining sort mode and pinned logic
  const comments = useMemo(() => {
    const rawComments = thread?.comments ?? [];

    // Clone once and apply combined sorting logic
    const sorted = rawComments.slice().sort((a, b) => {
      // Pinned comments always first
      const pinnedA = new Date(a.pinnedAt ?? 0).getTime();
      const pinnedB = new Date(b.pinnedAt ?? 0).getTime();
      const pinnedDiff = pinnedB - pinnedA;
      if (pinnedDiff !== 0) return pinnedDiff;

      // Then apply sort mode
      if (sort === ThreadSort.Newest) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      if (sort === ThreadSort.MostReactions) {
        return b.reactions.length - a.reactions.length;
      }
      // Oldest (default)
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    return !showMore ? sorted.slice(0, limit) : sorted;
  }, [thread?.comments, sort, showMore, limit]);

  const createdComments = useMemo(
    () => created.filter((x) => !comments?.some((comment) => comment.id === x.id)),
    [created, comments]
  );

  const isLocked = thread?.locked ?? false;
  const isReadonly = !features.canWrite;
  const isMuted = currentUser?.muted ?? false;
  let remaining = (thread?.comments?.length ?? 0) - limit;
  remaining = remaining > 0 ? remaining : 0;

  return (
    <CommentsCtx.Provider
      value={{
        data: comments,
        isLoading,
        isFetching,
        entityId,
        entityType,
        isLocked,
        isMuted,
        isReadonly,
        created,
        badges,
        limit,
        remaining,
        showMore,
        toggleShowMore,
        highlighted,
        hiddenCount,
        forceLocked,
        sort,
        setSort,
        parentThreadId: thread?.id,
        level,
      }}
    >
      {children({
        data: comments,
        isLoading,
        isFetching,
        isLocked,
        isMuted,
        isReadonly,
        created: createdComments,
        badges,
        limit,
        remaining,
        showMore,
        toggleShowMore,
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
  immer((set, get) => {
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
