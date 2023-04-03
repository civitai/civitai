import { InfiniteCommentV2Model } from '~/server/controllers/commentv2.controller';
import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Reactions, ReactionMetrics } from '~/components/Reaction/Reactions';
import { ReviewReactions } from '@prisma/client';
import React from 'react';

export function CommentReactions({ comment }: { comment: InfiniteCommentV2Model }) {
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
