import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { cloneElement, useCallback, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';

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
  return useStore(useCallback((state) => state.reactions[key] ?? {}, [key]));
};

export type ReactionButtonProps = ToggleReactionInput & {
  userReaction?: { userId: number; reaction: ReviewReactions };
  count?: number;
  countUnknown?: boolean;
  noEmpty?: boolean;
  children: ({
    hasReacted,
    count,
    countUnknown,
    reaction,
    canClick,
  }: {
    hasReacted: boolean;
    count: number;
    countUnknown: boolean;
    reaction: ReviewReactions;
    canClick: boolean;
  }) => React.ReactElement;
  readonly?: boolean;
  invisibleEmpty?: boolean;
};

export function ReactionButton({
  userReaction,
  count: initialCount = 0,
  countUnknown = false,
  entityType,
  entityId,
  reaction,
  readonly,
  children,
  noEmpty,
  invisibleEmpty,
}: ReactionButtonProps) {
  const currentUser = useCurrentUser();

  const key = getReactionKey({ entityType, entityId });
  const hasReactedInitial = !!userReaction;
  const hasReacted = useStore((state) => state.reactions?.[key]?.[reaction] ?? !!userReaction);
  const toggleReaction = useStore((state) => state.toggleReaction);

  const count = useMemo(() => {
    if (hasReactedInitial) {
      const optimisticCount = initialCount > 0 ? initialCount : 1;
      return hasReacted ? optimisticCount : Math.max(0, optimisticCount - 1);
    } else return hasReacted ? initialCount + 1 : initialCount;
  }, [hasReactedInitial, hasReacted, initialCount]);

  // What the store held when this button last toggled; the revert target if the server says no.
  const snapshot = useRef<boolean | undefined>(undefined);
  // Mutation-level callbacks (not the ones passed to `mutate`) still run after this button unmounts.
  const revert = (input: ToggleReactionInput) => {
    const previous = snapshot.current;
    if (previous === undefined) return;
    const current = useStore.getState().reactions[getReactionKey(input)]?.[input.reaction];
    // Another toggle may have moved the shared state on since: only undo our own change.
    if (current === !previous) toggleReaction({ ...input, value: previous });
  };
  // `isPending` lands a render late, so two clicks in one frame both passed it.
  const inFlight = useRef(false);
  const { mutate, isPending: isLoading } = trpc.reaction.toggle.useMutation({
    onSuccess(result, variables) {
      if (result === 'ignored') revert(variables);
    },
    onError(_error, variables) {
      revert(variables);
    },
    onSettled() {
      inFlight.current = false;
    },
  });

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (inFlight.current) return;
    inFlight.current = true;
    // Read the store, not the rendered value: a sibling button for the same entity may have toggled
    // in this same frame.
    const previous = useStore.getState().reactions[key]?.[reaction] ?? hasReactedInitial;
    snapshot.current = previous;
    toggleReaction({ entityType, entityId, reaction, value: !previous });
    mutate({ entityId, entityType, reaction });
  };

  const canClick = !!currentUser && !readonly && !isLoading;
  const child = children({ hasReacted, count, countUnknown, reaction, canClick });

  if (noEmpty && count < 1)
    return invisibleEmpty ? cloneElement(child, { className: 'invisible' }) : null;

  return canClick ? cloneElement(child, { onClick: handleClick }) : child;
}
