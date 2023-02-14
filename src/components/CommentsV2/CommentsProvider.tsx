import {
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteQueryObserverResult,
} from '@tanstack/react-query';
import { createContext, useContext, useMemo } from 'react';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';

type Props = CommentConnectorInput & {
  initialData?: InfiniteCommentResults['comments'];
  initialLimit?: number;
  initialCount?: number;
  children: ({
    data,
    isInitialLoading,
    isFetching,
    count,
    hasNextPage,
    hasPreviousPage,
  }: ChildProps) => React.ReactNode;
};

type ChildProps = {
  data?: InfiniteCommentResults['comments'];
  isInitialLoading?: boolean;
  isFetching?: boolean;
  count: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
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
}: Props) {
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
    { entityId, entityType },
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

  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments), [data]);

  return (
    <CommentsCtx.Provider
      value={{
        data: comments,
        isInitialLoading,
        isFetching,
        entityId,
        entityType,
        count,
        hasNextPage,
        fetchNextPage,
        hasPreviousPage,
        fetchPreviousPage,
      }}
    >
      {children({
        data: comments,
        isInitialLoading,
        isFetching,
        count,
        hasNextPage,
        hasPreviousPage,
      })}
    </CommentsCtx.Provider>
  );
}
