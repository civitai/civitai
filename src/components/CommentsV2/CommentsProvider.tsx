import { MantineColor } from '@mantine/core';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { useRouter } from 'next/router';
import { parseNumericString } from '~/utils/query-string-helpers';
import { CommentV2Model } from '~/server/selectors/commentv2.selector';

export type CommentV2BadgeProps = {
  userId: number;
  color: MantineColor;
  label: string;
};

type Props = CommentConnectorInput & {
  initialCount?: number;
  limit?: number;
  badges?: CommentV2BadgeProps[];
  children: (args: ChildProps) => React.ReactNode;
};

type ChildProps = {
  data?: CommentV2Model[];
  isLoading: boolean;
  isLocked: boolean;
  isMuted: boolean;
  created: CommentV2Model[];
  badges?: CommentV2BadgeProps[];
  limit?: number;
  remaining?: number;
  showMore: boolean;
  toggleShowMore: () => void;
  highlighted?: number;
};

type CommentsContext = CommentConnectorInput & ChildProps;

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
}: Props) {
  const router = useRouter();

  const currentUser = useCurrentUser();
  const storeKey = getKey(entityType, entityId);
  const created = useNewCommentStore(
    useCallback((state) => state.comments[storeKey] ?? [], [storeKey])
  );

  const [showMore, setShowMore] = useState(false);
  const toggleShowMore = () => setShowMore((b) => !b);

  const { data: thread, isInitialLoading: isLoading } = trpc.commentv2.getThreadDetails.useQuery(
    { entityId, entityType },
    {
      enabled: initialCount === undefined || initialCount > 0,
      onSuccess: (data) => {
        setLimit(getLimit(data?.comments));
      },
    }
  );
  const initialComments = useMemo(() => thread?.comments ?? [], [thread?.comments]);

  const highlighted = parseNumericString(router.query.highlight);
  const getLimit = (data: { id: number }[] = []) => {
    if (highlighted !== undefined) {
      const limit = data.findIndex((x) => x.id === highlighted) + 1;
      return limit < initialLimit ? initialLimit : limit;
    }

    return initialLimit;
  };
  const [limit, setLimit] = useState(getLimit(initialComments));

  const comments = useMemo(() => {
    const data = initialComments;
    return !showMore ? data.slice(0, limit) : data;
  }, [initialComments, showMore, limit]);

  const createdComments = useMemo(
    () => created.filter((x) => !comments?.some((comment) => comment.id === x.id)),
    [created, comments]
  );

  const isLocked = thread?.locked ?? false;
  const isMuted = currentUser?.muted ?? false;
  let remaining = initialComments.length - limit;
  remaining = remaining > 0 ? remaining : 0;

  return (
    <CommentsCtx.Provider
      value={{
        data: comments,
        isLoading,
        entityId,
        entityType,
        isLocked,
        isMuted,
        created,
        badges,
        limit,
        remaining,
        showMore,
        toggleShowMore,
        highlighted,
      }}
    >
      {children({
        data: comments,
        isLoading,
        isLocked,
        isMuted,
        created: createdComments,
        badges,
        limit,
        remaining,
        showMore,
        toggleShowMore,
        highlighted,
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
  addComment: (entityType: string, entityId: number, comment: CommentV2Model) => void;
  editComment: (entityType: string, entityId: number, comment: CommentV2Model) => void;
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
