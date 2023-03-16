import { useRouter } from 'next/router';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { trpc } from '~/utils/trpc';
import { Container, Title, Text } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { NotFound } from '~/components/AppLayout/NotFound';

export default function PostCreate() {
  const router = useRouter();
  const modelId = router.query.modelId ? Number(router.query.modelId) : undefined;
  const modelVersionId = router.query.modelVersionId
    ? Number(router.query.modelVersionId)
    : undefined;
  const { mutate, isLoading } = trpc.post.create.useMutation();
  const reset = useEditPostContext((state) => state.reset);
  const images = useEditPostContext((state) => state.images);
  const upload = useEditPostContext((state) => state.upload);
  const queryUtils = trpc.useContext();

  //TODO.posts - get modelversions related to modelId and have the user select a modelVersion before they can drop any images
  const { data: version, isLoading: versionLoading } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId ?? 0 },
    { enabled: !!modelVersionId }
  );

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

  const features = useFeatureFlags();
  if (!features.posts) return <NotFound />;

  return (
    <Container size="xs">
      <Title>Create image post</Title>
      {(version || versionLoading) && (
        <Text size="sm" color="dimmed">
          Posting to {version?.model.name} - {version?.name}
        </Text>
      )}
      <ImageDropzone
        mt="md"
        onDrop={handleDrop}
        loading={isLoading}
        count={images.length}
        max={50}
      />
    </Container>
  );
}

PostCreate.getLayout = PostEditLayout;
