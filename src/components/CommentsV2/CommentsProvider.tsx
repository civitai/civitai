import { MantineColor } from '@mantine/core';
import {
  FetchNextPageOptions,
  FetchPreviousPageOptions,
  InfiniteQueryObserverResult,
} from '@tanstack/react-query';
import { createContext, Dispatch, SetStateAction, useContext, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';

type CommentsResult = InfiniteCommentResults['comments'];

type BadgeProps = {
  userId: number;
  color: MantineColor;
  label: string;
};

type Props = CommentConnectorInput & {
  initialData?: CommentsResult;
  initialLimit?: number;
  initialCount?: number;
  limit?: number;
  badges?: BadgeProps[];
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
  badges?: BadgeProps[];
};

type CommentsContext = CommentConnectorInput &
  ChildProps & {
    setCreated: Dispatch<SetStateAction<CommentsResult>>;
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
  const [created, setCreated] = useState<CommentsResult>([]);
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
        setCreated,
        badges,
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
      })}
    </CommentsCtx.Provider>
  );
}
