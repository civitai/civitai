import { Button, Progress, Text } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { IconPhotoPlus } from '@tabler/icons-react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
import { getEdgeUrl } from '~/client-utils/edge-url';
import type { PreparingMedia } from '~/components/Post/EditV2/InFlightUploadTiles';
import { InFlightUploadTiles } from '~/components/Post/EditV2/InFlightUploadTiles';
import { usePostEditParams, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { useShowCreatePostError } from '~/components/Post/showCreatePostError';
import ImageSelectModal from '~/components/Training/Form/ImageSelectModal';
import type { SelectedImage } from '~/components/Training/Form/ImageSelectModal';
import { UploadNotice } from '~/components/UploadNotice/UploadNotice';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { useMediaUpload } from '~/hooks/useMediaUpload';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { addPostImageSchema } from '~/server/schema/post.schema';
import type { PostDetailEditable } from '~/server/services/post.service';
import {
  orchestratorMediaTransmitter,
  useExternalMetaStore,
  useOrchestratorUrlStore,
} from '~/store/post-image-transmitter.store';
import { hideNotification, showNotification } from '@mantine/notifications';
import { downloadGeneratorImages } from '~/utils/generator-import';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { isPickSnapshot } from '~/utils/unreadable-pick';

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
  const { maxItems } = useMediaUploadSettingsContext();
  const params = usePostEditParams();
  const currentUser = useCurrentUser();
  const showCreatePostError = useShowCreatePostError();
  const { src, modelVersionId, model3dId, storyline, continues, tag, collectionId } = params;
  // #endregion

  // #region [mutations]
  const createPostMutation = trpc.post.create.useMutation();
  const addImageMutation = trpc.post.addImage.useMutation({
    onSuccess: (data) => {
      setImages((images) => {
        const resolvingIndex = images.findIndex((x) => x.type === 'resolving');
        if (resolvingIndex > -1) images.splice(resolvingIndex, 1);
        const index = images.findIndex((x) => x.type === 'added' && x.data.id === data.id);
        if (index > -1) images[index] = { type: 'added', data: { ...data, index: data.index! } };
        else images.push({ type: 'added', data: { ...data, index: data.index! } });
        return images;
      });
    },
    onError: (_err, payload) => {
      // Release the dedupe slot so a retry (if ever wired up) isn't blocked.
      submittedUrlsRef.current.delete(payload.url);
    },
  });
  // #endregion

  // Dedupe by S3 key across this component's lifetime. Each pre-sign call
  // generates a unique key, so two mutations for the same key indicate a
  // duplicate submission that would otherwise create two image records.
  const submittedUrlsRef = useRef(new Set<string>());

  // #region [upload images]
  // Dropped files still backed by the device. Only their read failures are shown as unreadable
  // picks: an import, or an in-memory copy taken at the pick, fails only on its own content.
  const pickedFilesRef = useRef(new WeakSet<File>());
  const [unreadablePicks, setUnreadablePicks] = useState(0);
  const { files, canAdd, remaining, reserved, error, upload, progress, loading } = useMediaUpload<{
    postId: number;
  }>({
    count: images.length,
    onUnreadable: (file) => {
      if (!pickedFilesRef.current.has(file)) return false;
      setUnreadablePicks((n) => n + 1);
      return true;
    },
    onComplete: (props, context) => {
      const { postId = context?.postId, modelVersionId } = params;
      if (!postId) throw new Error('missing post id');

      switch (props.status) {
        case 'added': {
          if (submittedUrlsRef.current.has(props.url)) {
            console.warn(`[upload] Skipping duplicate addImage for url=${props.url}`);
            return;
          }
          submittedUrlsRef.current.add(props.url);

          const externalDetailsUrl = useExternalMetaStore.getState().getUrl();
          const payload = addPostImageSchema.parse({
            ...props,
            postId,
            modelVersionId,
            width: props.metadata.width,
            height: props.metadata.height,
            hash: props.metadata.hash,
            generationWorkflowId: props.generationWorkflowId,
            externalDetailsUrl,
          });

          // Update state first, then fire the mutation. Keeping side-effects
          // out of the zustand updater ensures the mutation can't be double-
          // invoked if the updater is ever re-run.
          setImages((images) => [...images, { type: 'resolving', data: { ...props } }]);
          addImageMutation.mutate(payload);
          break;
        }
        case 'blocked':
          setImages((images) => [...images, { type: 'blocked', data: { ...props } }]);
          break;
        case 'error':
          setImages((images) => [...images, { type: 'error', data: { ...props } }]);
          break;
      }
    },
  });
  // #endregion

  // #region [preparing]
  // Generator media shown from its source url from the moment it is picked until each item is a
  // queued upload with a local preview of its own, covering the download and the read for upload.
  const [preparing, setPreparing] = useState<{ id: number; items: PreparingMedia[] }[]>([]);
  const preparingIdRef = useRef(0);
  async function whilePreparing(items: PreparingMedia[], work: () => Promise<unknown>) {
    const id = preparingIdRef.current++;
    if (items.length) setPreparing((batches) => [...batches, { id, items }]);
    try {
      await work();
    } finally {
      setPreparing((batches) => batches.filter((batch) => batch.id !== id));
    }
  }
  // #endregion

  // #region [unanswered creates]
  // react-query runs a `mutate` call's own callbacks only for the latest call, and only while
  // mounted. A create those callbacks will never answer is settled here instead, so what waits on
  // it (preparing tiles, the import notification) does not wait forever.
  const unansweredCreatesRef = useRef(new Set<() => void>());
  useEffect(() => {
    const unanswered = unansweredCreatesRef.current;
    return () => {
      for (const settle of unanswered) settle();
    };
  }, []);
  // #endregion

  // #region [handlers]
  /** Settles once the files are queued for upload, or the post they need could not be made. */
  function handleUpload(
    fileData: { file: File; meta?: Record<string, unknown>; generationWorkflowId?: string }[]
  ): Promise<unknown> {
    if (currentUser?.muted) return Promise.resolve();
    if (post) return upload(fileData);
    return new Promise<void>((resolve) => {
      const unanswered = unansweredCreatesRef.current;
      for (const superseded of unanswered) superseded();
      const settle = () => {
        unanswered.delete(settle);
        resolve();
      };
      unanswered.add(settle);
      createPostMutation.mutate(
        {
          modelVersionId,
          model3dId,
          storylineId: storyline,
          parentChapterId: continues,
          tag,
          collectionId,
        },
        {
          onSuccess: async (data) => {
            try {
              queryUtils.post.getEdit.setData({ id: data.id }, () => data);
              // Refresh the version's post list so re-entering the post step (e.g. via
              // the wizard's back/next) reuses this post instead of creating a new one.
              if (modelVersionId) {
                await queryUtils.modelVersion.getById.invalidate({
                  id: modelVersionId,
                  withFiles: true,
                });
              }
              await onCreatePost?.(data);
              await upload(fileData, { postId: data.id });
            } finally {
              settle();
            }
          },
          onError(error) {
            showCreatePostError(error);
            settle();
          },
        }
      );
    });
  }

  const handleDrop = (args: { file: File; meta?: Record<string, unknown> }[]) => {
    for (const { file } of args) if (!isPickSnapshot(file)) pickedFilesRef.current.add(file);
    setUnreadablePicks(0);
    handleUpload(args);
  };

  const handleImportFromGenerator = async (assets: SelectedImage[]) => {
    if (!assets.length) return;

    const importNotifId = `importing-generator-${Date.now()}`;
    showNotification({
      id: importNotifId,
      loading: true,
      autoClose: false,
      withCloseButton: false,
      message: `Importing ${assets.length} image${
        assets.length !== 1 ? 's' : ''
      } from generator...`,
    });

    await whilePreparing(
      assets.map((asset) => ({
        url: getEdgeUrl(asset.url),
        type: asset.type === 'video' ? 'video' : 'image',
      })),
      async () => {
        const goodFiles = await downloadGeneratorImages(assets);
        if (goodFiles.length > 0) await handleUpload(goodFiles);
      }
    );

    // Hide notification after a short delay to allow upload to start
    setTimeout(() => {
      hideNotification(importNotifId);
    }, 500);
  };

  const openGeneratorImportModal = () => {
    const existingUrls = images
      .filter((img) => img.type === 'added')
      .map((img) => img.data.url)
      .filter(isDefined);

    dialogStore.trigger({
      component: ImageSelectModal,
      props: {
        title: 'Import from Generator',
        selectSource: 'generation',
        onSelect: handleImportFromGenerator,
        importedUrls: existingUrls,
        videoAllowed: true,
      },
    });
  };
  // #endregion

  const orchestratorTransferredMedia = useOrchestratorUrlStore((state) => state.data);
  // #region [orchestrator files]
  useEffect(() => {
    async function handleSrc() {
      if (!src) return;
      // getFiles empties the slot, so read the urls first.
      const sources = useOrchestratorUrlStore.getState().data[src] ?? [];
      let failedCount = 0;
      await whilePreparing(
        sources.map(({ url }) => ({ url })),
        async () => {
          const result = await orchestratorMediaTransmitter.getFiles(src);
          failedCount = result.failedCount;
          if (result.files.length) await handleUpload([...result.files]);
        }
      );
      if (failedCount)
        showErrorNotification({
          title: `${failedCount} file${
            failedCount !== 1 ? 's' : ''
          } from the generator didn't load`,
          error: { message: 'Add them with Import from Generator below.' },
          autoClose: false,
        });
    }
    handleSrc();
  }, [orchestratorTransferredMedia]); // eslint-disable-line
  // #endregion

  return (
    <div className="flex flex-col gap-1">
      <div className="w-full">
        <MediaDropzone
          onDrop={handleDrop}
          accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
          disabled={!canAdd}
          error={error}
          unreadablePicks={unreadablePicks}
          pickLimit={remaining}
          loading={createPostMutation.isPending || loading}
          className="rounded-lg"
        />
      </div>
      <Button
        variant="light"
        leftSection={<IconPhotoPlus size={16} />}
        onClick={openGeneratorImportModal}
        disabled={!canAdd}
        fullWidth
      >
        Import from Generator
      </Button>
      <Text size="sm" c={remaining === 0 ? 'orange' : 'dimmed'} ta="center" aria-live="polite">
        {images.length + reserved} / {maxItems} files
      </Text>
      {!!files.length && showProgress && <Progress value={progress} animated size="lg" />}
      <InFlightUploadTiles files={files} preparing={preparing.flatMap((batch) => batch.items)} />
      {!files.length && <UploadNotice />}
    </div>
  );
}
