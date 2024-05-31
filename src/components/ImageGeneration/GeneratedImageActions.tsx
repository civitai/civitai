import { ActionIcon, Text, Tooltip, MantineNumberSize, Button } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconInfoCircle, IconSquareOff, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  useGetTextToImageRequestsImages,
  useUpdateTextToImageWorkflows,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { generationPanel } from '~/store/generation.store';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import { isDefined } from '~/utils/type-guards';
import { constants } from '~/server/common/constants';

export function GeneratedImageActions({
  actionIconSize = 'lg',
  iconSize = 20,
}: {
  actionIconSize?: MantineNumberSize;
  iconSize?: number;
}) {
  const { selected, deselect, isMutating, deleteSelectedImages, postSelectedImages } =
    useGeneratedImageActions();

  const hasSelected = !!selected.length;
  if (!hasSelected) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center">
        <Text color="dimmed" weight={500} inline>
          {selected.length} Selected
        </Text>

        <ActionIcon size={actionIconSize} variant="transparent">
          <IconInfoCircle size={iconSize} />
        </ActionIcon>
      </div>
      <div className="flex gap-2">
        <Tooltip label="Deselect all">
          <ActionIcon size={actionIconSize} onClick={deselect} variant="filled">
            <IconSquareOff size={iconSize} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete selected">
          <ActionIcon
            size={actionIconSize}
            onClick={deleteSelectedImages}
            color="red"
            variant="light"
          >
            <IconTrash size={iconSize} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Post images to earn buzz!">
          <Button
            color="blue"
            size="sm"
            h={34}
            onClick={postSelectedImages}
            loading={isMutating}
            disabled={!hasSelected}
            sx={(theme) => ({
              '&[data-disabled]': {
                background: theme.colors.blue[theme.fn.primaryShade()],
                color: 'white',
                opacity: 0.5,
              },
            })}
          >
            Post
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

export function GeneratedImagesBuzzPrompt() {
  const { selected } = useGeneratedImageActions();
  const hasSelected = !!selected.length;
  if (hasSelected) return null;

  return (
    <Text align="center" color="yellow">
      Post images to earn buzz!
    </Text>
  );
}

export const useGeneratedImageActions = () => {
  const router = useRouter();
  const { images } = useGetTextToImageRequestsImages();

  const selected = generationImageSelect.useSelection();
  const deselect = () => generationImageSelect.setSelected([]);

  const createPostMutation = trpc.post.create.useMutation();
  const updateWorkflows = useUpdateTextToImageWorkflows({ onSuccess: () => deselect() });

  const deleteSelectedImages = () => {
    openConfirmModal({
      title: 'Delete images',
      children: 'Are you sure that you want to delete the selected images?',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete them' },
      confirmProps: { color: 'red' },
      onConfirm: () => updateWorkflows.hideImages(selected),
      zIndex: constants.imageGeneration.drawerZIndex + 2,
      centered: true,
    });
  };

  const isMutating = updateWorkflows.isLoading || createPostMutation.isLoading;

  const postSelectedImages = async () => {
    const imageIds = selected.flatMap((x) => x.imageIds);
    const urls = images
      .filter((x) => imageIds.includes(x.id))
      .map((x) => x.url)
      .filter(isDefined);
    try {
      const key = 'generator';
      orchestratorMediaTransmitter.setUrls(key, urls);
      const post = await createPostMutation.mutateAsync({});
      const pathname = `/posts/${post.id}/edit?src=${key}`;
      await router.push(pathname);
      generationPanel.close();
      deselect();
    } catch (e) {
      const error = e as Error;
      showErrorNotification({
        title: 'Failed to create post',
        error: new Error(error.message),
      });
    }
  };

  return {
    selected,
    deselect,
    isMutating,
    deleteSelectedImages,
    postSelectedImages,
  };
};
