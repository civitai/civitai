import { EntityDiscussion } from '~/components/CommentsV2/EntityDiscussion';

type Props = {
  crucibleId: number;
  userId?: number;
};

export function CrucibleDiscussion({ crucibleId, userId }: Props) {
  return <EntityDiscussion entityType="crucible" entityId={crucibleId} userId={userId} />;
}
