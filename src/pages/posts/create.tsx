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
  const images = useEditPostContext((state) => state.images);
  const upload = useEditPostContext((state) => state.upload);

  const handleDrop = (files: File[]) => {
    mutate(
      { modelVersionId },
      {
        onSuccess: async (response) => {
          const postId = response.id;
          router.push(`/posts/${postId}/edit`);
          upload(postId, files);
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
