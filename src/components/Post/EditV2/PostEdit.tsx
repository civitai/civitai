import { useEffect } from 'react';
import { CollectionUploadSettingsWrapper } from '~/components/Collections/components/CollectionUploadSettingsWrapper';
import { PostCollaboratorSelection } from '~/components/Post/EditV2/Collaborators/PostCollaborators';
import { EditPostReviews } from '~/components/Post/EditV2/EditPostReviews';
import { PostEditForm } from '~/components/Post/EditV2/PostEditForm';
import { usePostEditStore, usePostPreviewContext } from '~/components/Post/EditV2/PostEditProvider';
import { PostEditSidebar } from '~/components/Post/EditV2/PostEditSidebar';
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards/PostImageCards';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import { PostReorderImages } from '~/components/Post/EditV2/PostReorderImages';
import { useTourContext } from '~/providers/TourProvider';
import { removeDuplicates } from '~/utils/array-helpers';
import { isDefined } from '~/utils/type-guards';

export function PostEdit() {
  const [post, isReordering, collectionId] = usePostEditStore((state) => [
    state.post,
    state.isReordering,
    state.collectionId,
  ]);
  const { showPreview } = usePostPreviewContext();
  const { runTour, running } = useTourContext();

  useEffect(() => {
    if (!running && post?.id) runTour({ key: 'post-generation' });
  }, [post?.id]);

  if (!post) return null;

  return (
    <CollectionUploadSettingsWrapper
      collectionIds={removeDuplicates([collectionId, post.collectionId].filter(isDefined))}
    >
      <div className="@container">
        <div className="flex flex-col gap-3 @sm:flex-row @sm:justify-center @sm:gap-6">
          <div
            className="flex min-w-0 flex-1 flex-col gap-3"
            style={showPreview ? { maxWidth: 700 } : undefined}
          >
            <PostEditForm />
            {!isReordering ? (
              <>
                <PostImageDropzone />
                <PostImageCards />
              </>
            ) : (
              <PostReorderImages />
            )}
          </div>
          <div className="flex flex-col gap-3 @sm:w-72">
            <PostEditSidebar post={post} />
            <EditPostReviews post={post} />
            <PostCollaboratorSelection post={post} />
          </div>
        </div>
      </div>
    </CollectionUploadSettingsWrapper>
  );
}
