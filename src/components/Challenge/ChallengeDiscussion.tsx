import { Title } from '@mantine/core';
import { CommentSection } from '~/components/CommentsV3/CommentSection';

type Props = {
  challengeId: number;
  /** Badged "op": the judge on a system challenge, otherwise the creator. */
  userId?: number;
};

export function ChallengeDiscussion({ challengeId, userId }: Props) {
  return (
    <div className="mt-8">
      <CommentSection
        entityType="challenge"
        entityId={challengeId}
        ownerId={userId}
        ownerModerates={false}
        title={<Title order={2}>Discussion</Title>}
        hideWhenLocked
      />
    </div>
  );
}
