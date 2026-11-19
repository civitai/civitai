import { CommentSection } from '~/components/CommentsV3/CommentSection';

type ImageDetailCommentsProps = {
  imageId: number;
  userId: number;
};

export function ImageDetailComments({ imageId, userId }: ImageDetailCommentsProps) {
  return (
    <CommentSection
      entityType="image"
      entityId={imageId}
      ownerId={userId}
      title={null}
      hideSort
      borderless
    />
  );
}
