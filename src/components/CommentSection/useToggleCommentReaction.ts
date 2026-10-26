import { useRef } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ReactionDetails } from '~/server/selectors/reaction.selector';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/** Comment v1 reaction toggle, applied optimistically to `comment.getReactions`. */
export function useToggleCommentReaction(commentId: number) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  // `isPending` lands a render late, so two clicks in one frame both passed it.
  // One lock per reaction: a quick Like then Heart are different toggles, only a repeat is dropped.
  const inFlight = useRef(new Set<ReviewReactions>());

  const mutation = trpc.comment.toggleReaction.useMutation({
    async onMutate({ id, reaction }) {
      await queryUtils.comment.getReactions.cancel({ commentId: id });

      const previousReactions = queryUtils.comment.getReactions.getData({ commentId: id }) ?? [];
      const latestReaction =
        previousReactions.length > 0 ? previousReactions[previousReactions.length - 1] : { id: 0 };

      if (currentUser) {
        const newReaction: ReactionDetails = {
          id: latestReaction.id + 1,
          reaction,
          user: {
            id: currentUser.id,
            username: currentUser.username ?? '',
          },
        };
        const reacted = previousReactions.find(
          (r) => r.reaction === reaction && r.user.id === currentUser.id
        );
        queryUtils.comment.getReactions.setData({ commentId: id }, (old = []) =>
          reacted
            ? old.filter((oldReaction) => oldReaction.id !== reacted.id)
            : [...old, newReaction]
        );
      }

      return { previousReactions };
    },
    onSuccess(result, variables, context) {
      if (result === 'ignored')
        queryUtils.comment.getReactions.setData(
          { commentId: variables.id },
          context?.previousReactions
        );
    },
    onError(_error, variables, context) {
      queryUtils.comment.getReactions.setData(
        { commentId: variables.id },
        context?.previousReactions
      );
    },
    onSettled(_data, _error, variables) {
      inFlight.current.delete(variables.reaction);
    },
  });

  const toggle = (reaction: ReviewReactions) => {
    if (inFlight.current.has(reaction)) return;
    inFlight.current.add(reaction);
    mutation.mutate({ id: commentId, reaction });
  };

  return { toggle, isPending: mutation.isPending };
}
