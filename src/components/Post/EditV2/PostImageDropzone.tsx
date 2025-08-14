import { Anchor, Progress, Text } from '@mantine/core';
import { useEffect, useState } from 'react';
import { ContentPolicyLink } from '~/components/ContentPolicyLink/ContentPolicyLink';
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { UploadNotice } from '~/components/UploadNotice/UploadNotice';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { addPostImageSchema } from '~/server/schema/post.schema';
import type { PostDetailEditable } from '~/server/services/post.service';
import {
  orchestratorMediaTransmitter,
  useExternalMetaStore,
  useOrchestratorUrlStore,
} from '~/store/post-image-transmitter.store';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const max = POST_IMAGE_LIMIT;

export function PostImageDropzone({
  showProgress = true,
  onCreatePost,
}: {
  showProgress?: boolean;
  onCreatePost?: (post: PostDetailEditable) => void | Promise<void>;
}) {
  // #region [state]
  const queryUtils = trpc.useUtils();
  const [post, images, setImages] = usePostEditStore((state) => [
    state.post,
    state.images,
    state.setImages,
  ]);
  const params = usePostEditParams();
  const currentUser = useCurrentUser();
  const { src, modelVersionId, tag, collectionId } = params;
  // #endregion

  // #region [mutations]
  const createPostMutation = trpc.post.create.useMutation();
  const addImageMutation = trpc.post.addImage.useMutation({
    onSuccess: (data, payload) => {
      setImages((images) => {
        const resolvingIndex = images.findIndex((x) => x.type === 'resolving');
        if (resolvingIndex > -1) images.splice(resolvingIndex, 1);
        const index = images.findIndex((x) => x.type === 'added' && x.data.id === data.id);
        if (index > -1) images[index] = { type: 'added', data: { ...data, index: data.index! } };
        else images.push({ type: 'added', data: { ...data, index: data.index! } });
        return images;
      });

      if (payload.postId) {
        queryUtils.post.getEdit.setData({ id: payload.postId }, (old) => {
          if (!old) return old;

          return { ...old, images: [...(old.images || []), data] };
        });
      }
    },
  });
  // #endregion

  // #region [upload images]
  const { files, canAdd, error, upload, progress, loading } = useMediaUpload<{ postId: number }>({
    count: images.length,
    onComplete: (props, context) => {
      const { postId = context?.postId, modelVersionId } = params;
      if (!postId) throw new Error('missing post id');
      setImages((images) => {
        // const index = Math.max(0, ...images.map((x) => x.data.index)) + 1;
        switch (props.status) {
          case 'added':
            const externalDetailsUrl = useExternalMetaStore.getState().getUrl();

            const payload = addPostImageSchema.parse({
              ...props,
              postId,
              modelVersionId,
              width: props.metadata.width,
              height: props.metadata.height,
              hash: props.metadata.hash,
              externalDetailsUrl,
            });

            addImageMutation.mutate(payload);
            return [...images, { type: 'resolving', data: { ...props } }];
          case 'blocked':
            return [...images, { type: 'blocked', data: { ...props } }];
          case 'error':
            return [...images, { type: 'error', data: { ...props } }];
          default:
            return images;
        }
      });
    },
  });
  // #endregion

  // #region [handlers]
  function handleUpload(fileData: { file: File; meta?: Record<string, unknown> }[]) {
    if (currentUser?.muted) return;
    if (post) upload(fileData);
    else {
      createPostMutation.mutate(
        { modelVersionId, tag, collectionId },
        {
          onSuccess: async (data) => {
            queryUtils.post.getEdit.setData({ id: data.id }, () => data);
            await onCreatePost?.(data);
            upload(fileData, { postId: data.id });
          },
          onError(error) {
            showErrorNotification({
              title: 'Failed to create post',
              error: new Error(error.message),
            });
          },
        }
      );
    }
  }

  const handleDrop = (args: { file: File; meta?: Record<string, unknown> }[]) => {
    handleUpload(args);
  };
  // #endregion

  const orchestratorTransferredMedia = useOrchestratorUrlStore((state) => state.data);
  // #region [orchestrator files]
  useEffect(() => {
    async function handleSrc() {
      if (!src) return;
      const files = await orchestratorMediaTransmitter.getFiles(src);
      if (files.length) handleUpload([...files]);
    }
    handleSrc();
  }, [orchestratorTransferredMedia]); // eslint-disable-line
  // #endregion

  return (
    <div className={`flex flex-col gap-1`}>
      <div className="w-full">
        <MediaDropzone
          onDrop={handleDrop}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          disabled={!canAdd}
          error={error}
          loading={createPostMutation.isLoading || loading}
          className="rounded-lg"
        />
      </div>
      {!!files.length && showProgress && <Progress value={progress} animated size="lg" />}
      {!files.length && <UploadNotice />}
    </div>
  );
}
