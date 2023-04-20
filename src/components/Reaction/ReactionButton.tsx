import { ReviewReactions } from '@prisma/client';
import { cloneElement, useCallback, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { devtools } from 'zustand/middleware';
import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**NOTES**
  Why use zustand?
    - When a user adds a reaction, we're not going to invalidate the react-query cache of parent data. This means that, if a user were to navigate to another page and then come back, the reaction data from the react-query cache would not be accurate.
*/
type ReactionStore = {
  reactions: Record<string, Partial<Record<string, boolean>>>;
  toggleReaction: ({
    entityType,
    entityId,
    reaction,
    value,
  }: ToggleReactionInput & { value: boolean }) => void;
};

const getReactionKey = ({ entityType, entityId }: Omit<ToggleReactionInput, 'reaction'>) =>
  `${entityType}_${entityId}`;

const useStore = create<ReactionStore>()(
  devtools(
    immer((set) => ({
      reactions: {},
      toggleReaction: ({ entityType, entityId, reaction, value }) => {
        const key = getReactionKey({ entityType, entityId });
        set((state) => {
          if (!state.reactions[key]) state.reactions[key] = { [reaction]: value };
          else state.reactions[key][reaction] = value;
        });
      },
    }))
  )
);

export const useReactionsStore = ({
  entityType,
  entityId,
}: Omit<ToggleReactionInput, 'reaction'>) => {
  const key = getReactionKey({ entityType, entityId });
  return useStore(useCallback((state) => state.reactions[key], [key]));
};

export type ReactionButtonProps = ToggleReactionInput & {
  userReaction?: { userId: number; reaction: ReviewReactions };
  count?: number;
  noEmpty?: boolean;
  children: ({
    hasReacted,
    count,
    reaction,
    canClick,
  }: {
    hasReacted: boolean;
    count: number;
    reaction: ReviewReactions;
    canClick: boolean;
  }) => React.ReactElement;
  readonly?: boolean;
};

export function ReactionButton({
  userReaction,
  count: initialCount = 0,
  entityType,
  entityId,
  reaction,
  readonly,
  children,
  noEmpty,
}: ReactionButtonProps) {
  const currentUser = useCurrentUser();

  const key = getReactionKey({ entityType, entityId });
  const hasReactedInitial = !!userReaction;
  const hasReacted = useStore((state) => state.reactions?.[key]?.[reaction] ?? !!userReaction);
  const toggleReaction = useStore((state) => state.toggleReaction);

  const count = useMemo(() => {
    if (hasReactedInitial) {
      const optimisticCount = initialCount > 0 ? initialCount : 1;
      return hasReacted ? optimisticCount : optimisticCount - 1;
    } else return hasReacted ? initialCount + 1 : initialCount;
  }, [hasReactedInitial, hasReacted, initialCount]);

  const { mutate } = trpc.reaction.toggle.useMutation();

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    toggleReaction({ entityType, entityId, reaction, value: !hasReacted });
    mutate({
      entityId,
      entityType,
      reaction,
    });
  };

  if (noEmpty && count < 1) return null;

  const canClick = !!currentUser && !readonly;
  const child = children({ hasReacted, count, reaction, canClick });

  return canClick ? cloneElement(child, { onClick: handleClick }) : child;
}
