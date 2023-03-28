import { Button, Grid, Group, Stack, Text, Tooltip } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconAlertTriangle, IconArrowsSort } from '@tabler/icons';
import { useRouter } from 'next/router';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { ManagePostMaturity } from '~/components/Post/Edit/EditPostControls';
import { EditPostImages } from '~/components/Post/Edit/EditPostImages';
import { useEditPostContext } from '~/components/Post/Edit/EditPostProvider';
import { EditPostReviews } from '~/components/Post/Edit/EditPostReviews';
import { EditPostTags } from '~/components/Post/Edit/EditPostTags';
import { ReorderImages, ReorderImagesButton } from '~/components/Post/Edit/ReorderImages';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { trpc } from '~/utils/trpc';

export function PostUpsertForm({ modelVersionId, modelId }: Props) {
  const queryUtils = trpc.useContext();

  const reset = useEditPostContext((state) => state.reset);
  const reorder = useEditPostContext((state) => state.reorder);
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
          await upload({ postId, modelVersionId }, files);
          await queryUtils.modelVersion.getById.invalidate({ id: modelVersionId });
          await queryUtils.model.getById.invalidate({ id: modelId });
        },
      }
    );
  };

  const imagesCount = images.length;

  return postId ? (
    <Grid gutter="xl">
      <Grid.Col md={4} sm={6} orderSm={2}>
        <Stack spacing={50}>
          <Stack>
            <PublishButton modelId={modelId} modelVersionId={modelVersionId} />
            <ManagePostMaturity />
            <EditPostTags />
          </Stack>
          <ReorderImagesButton>
            {({ onClick, isLoading, isReordering, canReorder }) => (
              <Button
                onClick={onClick}
                disabled={!canReorder || imagesCount <= 1}
                loading={isLoading}
                variant="outline"
                leftIcon={<IconArrowsSort />}
              >
                {isReordering ? 'Done Rearranging' : 'Rearrange'}
              </Button>
            )}
          </ReorderImagesButton>
          <EditPostReviews />
        </Stack>
      </Grid.Col>
      <Grid.Col md={8} sm={6} orderSm={1}>
        {!reorder ? <EditPostImages max={10} /> : <ReorderImages />}
      </Grid.Col>
    </Grid>
  ) : (
    <ImageDropzone
      onDrop={handleDrop}
      loading={createPostMutation.isLoading}
      max={10}
      count={imagesCount}
    />
  );
}

type Props = { modelVersionId: number; modelId: number };

function PublishButton({ modelId, modelVersionId }: { modelId: number; modelVersionId: number }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const id = useEditPostContext((state) => state.id);
  const tags = useEditPostContext((state) => state.tags);
  const images = useEditPostContext((state) => state.images);
  const publishedAt = useEditPostContext((state) => state.publishedAt);
  const setPublishedAt = useEditPostContext((state) => state.setPublishedAt);

  const getFileUploadStatus = useS3UploadStore((state) => state.getStatus);
  const { uploading = 0 } = getFileUploadStatus((item) => item.meta?.versionId === modelVersionId);
  const isUploading = uploading > 0;

  const { data: modelVersion } = trpc.modelVersion.getById.useQuery({
    id: modelVersionId,
    withFiles: true,
  });

  const { mutate, isLoading } = trpc.post.update.useMutation();
  const publishModelMutation = trpc.model.publish.useMutation();

  const canSave =
    tags.filter((x) => !!x.id).length > 0 && images.filter((x) => x.type === 'image').length > 0;
  const canPublish = !isUploading && !!modelVersion?.files?.length;

  console.log({ canPublish, canSave, isUploading, modelVersion });

  const handlePublish = () => {
    if (!currentUser) return;
    const publishedAt = new Date();
    publishModelMutation.mutate({ id: modelId, versionIds: [modelVersionId] });
    mutate(
      { id, publishedAt },
      {
        async onSuccess() {
          setPublishedAt(publishedAt);
          await queryUtils.model.getById.invalidate({ id: modelId });
          await queryUtils.modelVersion.getById.invalidate({ id: modelVersionId });
          await queryUtils.image.getInfinite.invalidate();
          await router.replace(`/models/v2/${modelId}?modelVersionId=${modelVersionId}`);
        },
      }
    );
  };

  const handleSave = () => {
    openConfirmModal({
      centered: true,
      title: (
        <Group spacing="xs">
          <IconAlertTriangle color="gold" />
          Save draft
        </Group>
      ),
      children:
        'Files for this version are missing or still uploading. Your version will be saved as draft until all files are uploaded. We will notify you when it is ready to be published.',
      onConfirm: () => {
        const publishedAt = new Date();
        mutate(
          { id, publishedAt },
          {
            async onSuccess() {
              setPublishedAt(publishedAt);
              await queryUtils.model.getById.invalidate({ id: modelId });
              await queryUtils.modelVersion.getById.invalidate({ id: modelVersionId });
              await queryUtils.image.getInfinite.invalidate();
              await router.replace(`/models/v2/${modelId}?modelVersionId=${modelVersionId}`);
            },
          }
        );
      },
    });
  };

  return (
    <Stack spacing={4}>
      {!publishedAt && (
        <Tooltip
          disabled={canSave}
          label="At least one tag is required in order to publish this post to the community"
          multiline
          width={260}
          withArrow
        >
          <div style={{ display: 'flex', flex: 2 }}>
            <Button
              disabled={!canSave}
              style={{ flex: 1 }}
              onClick={canPublish ? handlePublish : handleSave}
              loading={isLoading}
            >
              {canPublish ? 'Publish' : 'Save'}
            </Button>
          </div>
        </Tooltip>
      )}
      <Text size="xs">
        {!publishedAt ? (
          <>
            Your post is currently{' '}
            <Tooltip
              label="When a post is Hidden, you can grab a link and share it outside of the Civitai community.  Click the '${publishText}' button to make your post Public to share with the Civitai community for comments and reactions."
              maw={300}
              position="bottom"
              withArrow
              multiline
            >
              <Text component="span" underline>
                hidden
              </Text>
            </Tooltip>
          </>
        ) : (
          <>
            Published <DaysFromNow date={publishedAt} />
          </>
        )}
      </Text>
    </Stack>
  );
}
