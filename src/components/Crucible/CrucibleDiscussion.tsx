import { Title } from '@mantine/core';
import { CommentSection } from '~/components/CommentsV3/CommentSection';

type Props = {
  crucibleId: number;
  userId?: number;
};

export function CrucibleDiscussion({ crucibleId, userId }: Props) {
  return (
    <div className="mt-8">
      <CommentSection
        entityType="crucible"
        entityId={crucibleId}
        ownerId={userId}
        ownerModerates={false}
        title={<Title order={2}>Discussion</Title>}
        hideWhenLocked
        anchorId="comments"
      />
    </div>
  );
}
