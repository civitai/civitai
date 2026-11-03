import { CommentSection } from '~/components/CommentsV3/CommentSection';

type ArticleDetailCommentsProps = {
  articleId: number;
  userId: number;
};

export function ArticleDetailComments({ articleId, userId }: ArticleDetailCommentsProps) {
  return (
    <div className="mt-8">
      <CommentSection entityType="article" entityId={articleId} ownerId={userId} hideWhenLocked />
    </div>
  );
}
