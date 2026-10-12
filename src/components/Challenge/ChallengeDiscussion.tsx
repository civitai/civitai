import { EntityDiscussion } from '~/components/CommentsV2/EntityDiscussion';

type Props = {
  challengeId: number;
  userId?: number;
};

export function ChallengeDiscussion({ challengeId, userId }: Props) {
  return <EntityDiscussion entityType="challenge" entityId={challengeId} userId={userId} />;
}
