import { CommentSection } from '~/components/CommentsV3/CommentSection';

type PostCommentsProps = {
  postId: number;
  userId: number;
};

export function PostComments({ postId, userId }: PostCommentsProps) {
  return (
    <CommentSection entityType="post" entityId={postId} ownerId={userId} anchorId="comments" />
  );
}
