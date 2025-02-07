import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Reactions, ReactionMetrics } from '~/components/Reaction/Reactions';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import React from 'react';
import type { Comment } from '~/server/services/commentsv2.service';

export function CommentReactions({ comment }: { comment: Comment }) {
  const currentUser = useCurrentUser();
  const userReactions = comment.reactions.filter((x) => x.userId === currentUser?.id);
  const metrics = useMemo(
    (): ReactionMetrics => ({
      likeCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Like).length,
      dislikeCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Dislike).length,
      heartCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Heart).length,
      laughCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Laugh).length,
      cryCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Cry).length,
    }),
    [comment.reactions]
  );

  return (
    <Reactions
      reactions={userReactions}
      entityId={comment.id}
      entityType="comment"
      metrics={metrics}
    />
  );
}
