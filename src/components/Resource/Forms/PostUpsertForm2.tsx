import { Center, Loader, Text, Container, Title } from '@mantine/core';
import { ModelStatus } from '@prisma/client';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { PostEdit } from '~/components/Post/EditV2/PostEdit';
import { PostEditProvider } from '~/components/Post/EditV2/PostEditProvider';
import { PostImageDropzone } from '~/components/Post/EditV2/PostImageDropzone';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function PostUpsertForm2({
  postId: initialPostId = 0,
  modelVersionId,
  modelId,
}: {
  postId?: number;
  modelVersionId: number;
  modelId: number;
}) {
  // #region [state]
  const router = useRouter();
  const [postId, setPostId] = useState(initialPostId);
  const getFileUploadStatus = useS3UploadStore((state) => state.getStatus);
  const { uploading = 0 } = getFileUploadStatus((item) => item.meta?.versionId === modelVersionId);
  // #endregion

  // #region [queries]
  const { data: modelVersion } = trpc.modelVersion.getById.useQuery({
    id: modelVersionId,
    withFiles: true,
  });

  const { data, isInitialLoading } = trpc.post.getEdit.useQuery(
    { id: postId },
    { enabled: postId > 0, keepPreviousData: false }
  );
  // #endregion

  // #region [mutations]
  async function onSuccess() {
    await router.replace(`/models/${modelId}?modelVersionId=${modelVersionId}`);
  }

  function onError(error: any) {
    showErrorNotification({
      title: 'Failed to publish',
      error: new Error(error.message),
      reason: 'Something went wrong while publishing your model. Please try again later.',
    });
  }
  const publishModelMutation = trpc.model.publish.useMutation({ onError, onSuccess });
  const publishVersionMutation = trpc.modelVersion.publish.useMutation({ onError, onSuccess });

  // #endregion

  // #region [misc]
  const isCreatePage = !postId;
  const is404 = !data && !isInitialLoading && !isCreatePage;
  const loading = isInitialLoading && !isCreatePage;
  const isUploading = uploading > 0;
  const canPublish = !isUploading && !!modelVersion?.files?.length;
  const confirmPublish = !canPublish;
  const confirmMessage = confirmPublish
    ? 'Files for this version are missing or still uploading. Your version will be saved as draft until all files are uploaded. We will notify you when it is ready to be published.'
    : undefined;
  const confirmTitle = (
    <div className="flex items-center gap-1">
      <IconAlertTriangle color="gold" />
      <span>Publish post</span>
    </div>
  );
  // #endregion

  return (
    <div className={`flex flex-col gap-3 container ${isCreatePage ? 'max-w-sm' : 'max-w-lg'}`}>
      <Title order={3}>{isCreatePage ? 'Create your post' : 'Edit post'}</Title>
      <PostEditProvider
        post={data}
        params={{ modelVersionId, src: 'trainer' }}
        confirmPublish={confirmPublish}
        confirmMessage={confirmMessage}
        confirmTitle={confirmTitle}
        postTitle={
          modelVersion ? `${modelVersion.model.name} - ${modelVersion.name} Showcase` : undefined
        }
        afterPublish={({ publishedAt }) => {
          if (canPublish) {
            if (modelVersion && modelVersion.model.status !== ModelStatus.Published) {
              publishModelMutation.mutate({
                id: modelId,
                versionIds: [modelVersionId],
                publishedAt,
              });
            } else {
              publishVersionMutation.mutate({ id: modelVersionId, publishedAt });
            }
          }
        }}
      >
        {is404 ? (
          <NotFound />
        ) : loading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : isCreatePage ? (
          <div className="flex flex-col gap-3">
            <Text size="xs" color="dimmed">
              Our site is mostly used for sharing AI generated content. Make sure the images you are
              sharing for this resource have been generated with it.
            </Text>
            <PostImageDropzone onCreatePost={(post) => setPostId(post.id)} />
          </div>
        ) : (
          <PostEdit />
        )}
      </PostEditProvider>
    </div>
  );
}
