import { CommentSection } from '~/components/CommentsV3/CommentSection';

type Props = {
  bountyEntryId: number;
  userId?: number;
};

export function BountyEntryDiscussion({ bountyEntryId, userId }: Props) {
  return (
    <CommentSection
      entityType="bountyEntry"
      entityId={bountyEntryId}
      ownerId={userId}
      ownerModerates={false}
      title={null}
      hideSort
      borderless
    />
  );
}
