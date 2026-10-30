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

// Per entity and reaction, across every button: requests in flight, and server answers received.
const pending = new Map<string, number>();
const answers = new Map<string, number>();
const answerKey = (input: ToggleReactionInput) => `${getReactionKey(input)}_${input.reaction}`;

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

  // What the store held when this button last toggled, and how many server answers had landed.
  const snapshot = useRef<{ previous: boolean; answers: number } | undefined>(undefined);
  // Mutation-level callbacks (not the ones passed to `mutate`) still run after this button unmounts.
  const settle = (input: ToggleReactionInput, result?: string) => {
    const k = answerKey(input);
    pending.set(k, Math.max(0, (pending.get(k) ?? 0) - 1));
    // The server applies whichever request claims the toggle first, so its answer is the truth.
    if (result === 'created' || result === 'removed' || result === 'noop') {
      answers.set(k, (answers.get(k) ?? 0) + 1);
      toggleReaction({ ...input, value: result === 'created' });
      return;
    }
    // Ignored or failed: undo our own change, unless a sibling's answer has landed since or one is
    // still on its way to say what the server holds.
    const taken = snapshot.current;
    if (!taken || pending.get(k) || (answers.get(k) ?? 0) !== taken.answers) return;
    toggleReaction({ ...input, value: taken.previous });
  };
  // `isPending` lands a render late, so two clicks in one frame both passed it.
  const inFlight = useRef(false);
  const { mutate, isPending: isLoading } = trpc.reaction.toggle.useMutation({
    onSuccess(result, variables) {
      settle(variables, result);
    },
    onError(_error, variables) {
      settle(variables);
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
    const k = answerKey({ entityType, entityId, reaction });
    snapshot.current = { previous, answers: answers.get(k) ?? 0 };
    pending.set(k, (pending.get(k) ?? 0) + 1);
    toggleReaction({ entityType, entityId, reaction, value: !previous });
    mutate({ entityId, entityType, reaction });
  };

  const canClick = !!currentUser && !readonly && !isLoading;
  const child = children({ hasReacted, count, countUnknown, reaction, canClick });

  if (noEmpty && count < 1)
    return invisibleEmpty ? cloneElement(child, { className: 'invisible' }) : null;

  return canClick ? cloneElement(child, { onClick: handleClick }) : child;
}
