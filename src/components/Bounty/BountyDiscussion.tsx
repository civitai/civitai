import { CommentSection } from '~/components/CommentsV3/CommentSection';

type Props = {
  bountyId: number;
  userId?: number;
};

export function BountyDiscussion({ bountyId, userId }: Props) {
  return (
    <CommentSection
      entityType="bounty"
      entityId={bountyId}
      ownerId={userId}
      ownerModerates={false}
      title={null}
      hideSort
      emptyState={null}
    />
  );
}
