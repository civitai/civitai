import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { PostEditComposite } from '~/components/Post/Edit/PostEditComposite';
import { trpc } from '~/utils/trpc';

export function PostUpsertForm({ modelVersionId, modelId }: Props) {
  const queryUtils = trpc.useContext();

  const reset = useEditPostContext((state) => state.reset);
  const images = useEditPostContext((state) => state.images);
  const upload = useEditPostContext((state) => state.upload);
  const postId = useEditPostContext((state) => state.id);

  const createPostMutation = trpc.post.create.useMutation();

  const handleDrop = (files: File[]) => {
    createPostMutation.mutate(
      { modelVersionId },
      {
        onSuccess: async (response) => {
          reset();
          const postId = response.id;
          queryUtils.post.getEdit.setData({ id: postId }, () => response);
          upload({ postId, modelVersionId }, files);
          await queryUtils.model.getById.invalidate({ id: modelId });
        },
      }
    );
  };

  return postId ? (
    <PostEditComposite />
  ) : (
    <ImageDropzone
      onDrop={handleDrop}
      loading={createPostMutation.isLoading}
      max={50}
      count={images.length}
    />
  );
}

type Props = { modelVersionId: number; modelId: number };
