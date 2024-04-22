import { Container } from '@mantine/core';
import { EditPostReviews } from '~/components/Post/EditV2/EditPostReviews';
import { PostEditForm } from '~/components/Post/EditV2/PostEditForm';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { PostEditSidebar } from '~/components/Post/EditV2/PostEditSidebar';
import { PostImageCards } from '~/components/Post/EditV2/PostImageCards';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import { PostReorderImages } from '~/components/Post/EditV2/PostReorderImages';

export function PostEdit() {
  const [post, isReordering] = usePostEditStore((state) => [state.post, state.isReordering]);
  if (!post) return null;

  return (
    <Container size="lg" className="@container px-3">
      <div className="flex flex-col gap-3 @sm:flex-row">
        <div className="flex flex-col gap-3 flex-1 ">
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
        </div>
      </div>
    </Container>
  );
}
