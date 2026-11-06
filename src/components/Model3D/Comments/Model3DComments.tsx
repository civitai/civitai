import { CommentSection } from '~/components/CommentsV3/CommentSection';

type Model3DCommentsProps = {
  model3dId: number;
  userId: number;
};

export function Model3DComments({ model3dId, userId }: Model3DCommentsProps) {
  return (
    <div className="mt-8">
      <CommentSection entityType="model3d" entityId={model3dId} ownerId={userId} hideWhenLocked />
    </div>
  );
}
