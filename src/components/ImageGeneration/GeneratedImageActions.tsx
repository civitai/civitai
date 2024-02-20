import { ActionIcon, Text, Tooltip, MantineNumberSize, Button, HoverCard } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCloudUpload, IconSquareOff, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  useDeleteGenerationRequestImages,
  useGetGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { constants } from '~/server/common/constants';
import { generationPanel } from '~/store/generation.store';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { showErrorNotification } from '~/utils/notifications';
import { getOrchestratorMediaFilesFromUrls } from '~/utils/orchestration';

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
  return (
    <>
      {hasSelected && (
        <>
          <Text color="dimmed" size="sm" weight={500} inline>
            {selected.length} selected
          </Text>
          <Tooltip label="Deselect all">
            <ActionIcon size={actionIconSize} onClick={deselect} variant="light">
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
        </>
      )}
      <HoverCard withinPortal width={200} shadow="sm" offset={5}>
        <HoverCard.Target>
          <div>
            <Button
              color="blue"
              size="sm"
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
          </div>
        </HoverCard.Target>
        <HoverCard.Dropdown p="xs">
          <Text size="sm" lh={1.2}>
            Select one or more images to post and earn Buzz.
          </Text>
        </HoverCard.Dropdown>
      </HoverCard>
      {/* <Tooltip label="Upscale images">
        <span>
          <ActionIcon size={actionIconSize} variant="light" disabled>
            <IconWindowMaximize size={iconSize} />
          </ActionIcon>
        </span>
      </Tooltip> */}
    </>
  );
}

export const useGeneratedImageActions = () => {
  const router = useRouter();
  const { images } = useGetGenerationRequests();

  const selected = generationImageSelect.useSelection();
  const deselect = () => generationImageSelect.setSelected([]);

  const createPostMutation = trpc.post.create.useMutation();
  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages({
    onSuccess: () => deselect(),
  });

  const deleteSelectedImages = () => {
    openConfirmModal({
      title: 'Delete images',
      children:
        'Are you sure that you want to delete the selected images? This is a destructive action and cannot be undone.',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete them' },
      confirmProps: { color: 'red' },
      onConfirm: () => bulkDeleteImagesMutation.mutate({ ids: selected }),
      zIndex: constants.imageGeneration.drawerZIndex + 2,
      centered: true,
    });
  };

  const isMutating = bulkDeleteImagesMutation.isLoading || createPostMutation.isLoading;

  const postSelectedImages = async () => {
    const urls = images.filter((x) => selected.includes(x.id)).map((x) => x.url);
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
