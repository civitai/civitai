import { MantineColor } from '@mantine/core';
import {
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteQueryObserverResult,
} from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

type CommentsResult = InfiniteCommentResults['comments'];
type CommentModel = InfiniteCommentResults['comments'][0];

export type CommentV2BadgeProps = {
  userId: number;
  color: MantineColor;
  label: string;
};

type Props = CommentConnectorInput & {
  initialData?: CommentsResult;
  initialLimit?: number;
  initialCount?: number;
  limit?: number;
  badges?: CommentV2BadgeProps[];
  children: ({
    data,
    isInitialLoading,
    isFetching,
    count,
    isLocked,
    isMuted,
    hasNextPage,
    hasPreviousPage,
    created,
    badges,
  }: ChildProps) => React.ReactNode;
};

type ChildProps = {
  data?: CommentsResult;
  isInitialLoading?: boolean;
  isFetching?: boolean;
  count: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  isLocked: boolean;
  isMuted: boolean;
  created: CommentsResult;
  badges?: CommentV2BadgeProps[];
  limit?: number;
};

type CommentsContext = CommentConnectorInput &
  ChildProps & {
    fetchNextPage: (
      options?: FetchNextPageOptions | undefined
    ) => Promise<InfiniteQueryObserverResult<InfiniteCommentResults>>;
    fetchPreviousPage: (
      options?: FetchPreviousPageOptions | undefined
    ) => Promise<InfiniteQueryObserverResult<InfiniteCommentResults>>;
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
  initialData,
  initialLimit,
  initialCount,
  limit,
  badges,
}: Props) {
  const currentUser = useCurrentUser();
  const storeKey = getKey(entityType, entityId);
  const created = useNewCommentStore(
    useCallback((state) => state.comments[storeKey] ?? [], [storeKey])
  );
  const { items, nextCursor } = useMemo(() => {
    const data = [...(initialData ?? [])];
    return {
      nextCursor: initialLimit && data.length > initialLimit ? data.splice(-1)[0]?.id : undefined,
      items: data,
    };
  }, [initialData, initialLimit]);

  const {
    data,
    isInitialLoading,
    isFetching,
    fetchNextPage,
    hasNextPage,
    fetchPreviousPage,
    hasPreviousPage,
  } = trpc.commentv2.getInfinite.useInfiniteQuery(
    { entityId, entityType, limit },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      initialData: !!initialData
        ? {
            pages: [{ nextCursor, comments: items }],
            pageParams: [null],
          }
        : undefined,
    }
  );

  const { data: count = 0 } = trpc.commentv2.getCount.useQuery(
    { entityId, entityType },
    { initialData: initialCount }
  );

  const { data: thread } = trpc.commentv2.getThreadDetails.useQuery({ entityId, entityType });

  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments), [data]);
  const createdComments = useMemo(
    () => created.filter((x) => !comments?.some((comment) => comment.id === x.id)),
    [created, comments]
  );
  const isLocked = useMemo(() => thread?.locked ?? false, [thread]);
  const isMuted = currentUser?.muted ?? false;

  return (
    <CommentsCtx.Provider
      value={{
        data: comments,
        isInitialLoading,
        isFetching,
        entityId,
        entityType,
        count,
        isLocked,
        isMuted,
        hasNextPage,
        fetchNextPage,
        hasPreviousPage,
        fetchPreviousPage,
        created,
        badges,
        limit,
      }}
    >
      {children({
        data: comments,
        isInitialLoading,
        isFetching,
        count,
        isLocked,
        isMuted,
        hasNextPage,
        hasPreviousPage,
        created: createdComments,
        badges,
        limit,
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
  comments: Record<string, CommentModel[]>;
  addComment: (entityType: string, entityId: number, comment: CommentModel) => void;
  editComment: (entityType: string, entityId: number, comment: CommentModel) => void;
  deleteComment: (entityType: string, entityId: number, commentId: number) => void;
};

const getKey = (entityType: string, entityId: number) => `${entityId}_${entityType}`;

export const useNewCommentStore = create<StoreProps>()(
  immer((set, get) => {
    return {
      comments: {},
      addComment: (entityType, entityId, comment) =>
        set((state) => {
          const key = getKey(entityType, entityId);
          if (!state.comments[key]?.length) state.comments[key] = [comment];
          else state.comments[key].push(comment);
        }),
      editComment: (entityType, entityId, comment) =>
        set((state) => {
          const key = getKey(entityType, entityId);
          const index = state.comments[key].findIndex((x) => x.id === comment.id);
          if (index > -1) state.comments[key][index].content = comment.content;
        }),
      deleteComment: (entityType, entityId, commentId) =>
        set((state) => {
          const key = getKey(entityType, entityId);
          state.comments[key] = state.comments[key].filter((x) => x.id !== commentId);
        }),
    };
  })
);
