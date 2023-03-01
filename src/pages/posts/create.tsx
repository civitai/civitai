import { useRouter } from 'next/router';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { PostEditLayout } from '~/components/Post/PostEditLayout';
import { usePostImagesContext } from '~/components/Post/PostImagesProvider';
import { trpc } from '~/utils/trpc';
import { Container } from '@mantine/core';

export default function PostCreate() {
  const router = useRouter();
  const modelVersionId = Number(router.query.modelVersionId);
  const { mutate, isLoading } = trpc.post.create.useMutation();
  const { items, upload } = usePostImagesContext();

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
    <Container size="xl">
      <ImageDropzone onDrop={handleDrop} loading={isLoading} count={items.length} />
    </Container>
  );
}

PostCreate.getLayout = PostEditLayout;
