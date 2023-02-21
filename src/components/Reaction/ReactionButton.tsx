import { ReviewReactions } from '@prisma/client';
import { cloneElement, useMemo, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { trpc } from '~/utils/trpc';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

/**NOTES**
  Why use zustand?
    - When a user adds a reaction, we're not going to invalidate the react-query cache of parent data. This means that, if a user were to navigate to another page and then come back, the reaction data from the react-query cache would not be accurate.
*/
type ReactionStore = {
  reactions: Record<string, Partial<Record<ReviewReactions, boolean>>>;
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
);

export type ReactionButtonProps = ToggleReactionInput & {
  userReaction?: ReactionDetails;
  count?: number;
  noEmpty?: boolean;
  children: ({
    hasReacted,
    count,
    reaction,
  }: {
    hasReacted: boolean;
    count: number;
    reaction: ReviewReactions;
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

  const canClick = currentUser && !readonly;
  const child = children({ hasReacted, count, reaction });

  return canClick ? cloneElement(child, { onClick: handleClick }) : child;
}
