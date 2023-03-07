import { useRouter } from 'next/router';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { trpc } from '~/utils/trpc';
import { Container } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';

export default function PostCreate() {
  const router = useRouter();
  const modelVersionId = router.query.modelVersionId
    ? Number(router.query.modelVersionId)
    : undefined;
  const { mutate, isLoading } = trpc.post.create.useMutation();
  const reset = useEditPostContext((state) => state.reset);
  const images = useEditPostContext((state) => state.images);
  const upload = useEditPostContext((state) => state.upload);
  const queryUtils = trpc.useContext();

  const handleDrop = (files: File[]) => {
    mutate(
      { modelVersionId },
      {
        onSuccess: async (response) => {
          reset();
          const postId = response.id;
          queryUtils.post.getEdit.setData({ id: postId }, () => response);
          upload({ postId, modelVersionId }, files);
          router.push({ pathname: `/posts/${postId}/edit` });
        },
      }
    );
  };

  return (
    <Container size="xs">
      <ImageDropzone onDrop={handleDrop} loading={isLoading} count={images.length} />
    </Container>
  );
}

PostCreate.getLayout = PostEditLayout;

/*  TODO.posts - add to migration
UPDATE "Tag" SET target = array_append(target, 'Post')
WHERE 'Image' = ANY(Target);
*/
