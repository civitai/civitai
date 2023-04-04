import { useRouter } from 'next/router';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { PostEditLayout } from '~/components/Post/Edit/PostEditLayout';
import { trpc } from '~/utils/trpc';
import { Container, Title, Text, Select, Group } from '@mantine/core';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useState } from 'react';
import { BackButton } from '~/components/BackButton/BackButton';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';

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

  const { data: versions, isLoading: versionsLoading } = trpc.model.getVersions.useQuery(
    { id: modelId ?? 0 },
    { enabled: !!modelId }
  );

  const { data: version, isLoading: versionLoading } = trpc.modelVersion.getById.useQuery(
    { id: modelVersionId ?? 0 },
    { enabled: !!modelVersionId }
  );

  const [selected, setSelected] = useState<string | undefined>(modelVersionId?.toString());

  const handleDrop = (files: File[]) => {
    const versionId = selected ? Number(selected) : modelVersionId;
    mutate(
      { modelVersionId: versionId },
      {
        onSuccess: async (response) => {
          reset();
          const postId = response.id;
          queryUtils.post.getEdit.setData({ id: postId }, () => response);
          upload({ postId, modelVersionId: versionId }, files);
          const returnUrl = router.query.returnUrl as string;
          let pathname = `/posts/${postId}/edit`;
          if (returnUrl) pathname += `?returnUrl=${returnUrl}`;

          router.push(pathname);
        },
      }
    );
  };

  let backButtonUrl = modelId ? `/models/${modelId}` : '/';
  if (modelVersionId) backButtonUrl += `?modelVersionId=${modelVersionId}`;

  return (
    <Container size="xs">
      <Group spacing="xs">
        <BackButton url={backButtonUrl} />
        <Title>Create image post</Title>
      </Group>
      {modelVersionId && (version || versionLoading) && (
        <Text size="sm" color="dimmed">
          Posting to {version?.model.name} - {version?.name}
        </Text>
      )}
      {versions && (
        <Select
          description="Select a resource to ensure that all uploaded images receive correct resource attribution"
          placeholder="Select a resource"
          value={selected}
          data={versions.map(({ id, name }) => ({ label: name, value: id.toString() }))}
          onChange={(value) => {
            if (value) setSelected(value);
          }}
        />
      )}
      <ImageDropzone
        mt="md"
        onDrop={handleDrop}
        loading={isLoading}
        count={images.length}
        max={POST_IMAGE_LIMIT}
      />
    </Container>
  );
}

PostCreate.getLayout = PostEditLayout;
