import {
  ActionIcon,
  Center,
  Group,
  Loader,
  Text,
  Tooltip,
  createStyles,
  TooltipProps,
  LoadingOverlay,
  Box,
  Stack,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconCloudUpload, IconSquareOff, IconTrash, IconWindowMaximize } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  useDeleteGenerationRequestImages,
  useGetGenerationRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { constants } from '~/server/common/constants';
import { Generation } from '~/server/services/generation/generation.types';
import { generationPanel } from '~/store/generation.store';
import { postImageTransmitter } from '~/store/post-image-transmitter.store';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export function Feed({
  requests,
  images: feed,
  fetchNextPage,
  hasNextPage,
  isRefetching,
  isFetchingNextPage,
}: ReturnType<typeof useGetGenerationRequests>) {
  const { classes } = useStyles();

  return (
    <Stack
      spacing="xs"
      sx={{ position: 'relative', flex: 1, overflow: 'hidden', containerType: 'inline-size' }}
    >
      <div className={classes.grid}>
        {feed
          .map((image) => {
            const request = requests.find((request) =>
              request.images?.some((x) => x.id === image.id)
            );
            if (!request) return null;

            return <GeneratedImage key={image.id} request={request} image={image} />;
          })
          .filter(isDefined)}
      </div>
      {hasNextPage && (
        <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && !isFetchingNextPage}>
          <Center sx={{ height: 60 }}>
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: constants.imageGeneration.drawerZIndex + 1,
};

export function FloatingFeedActions({ images = [], children }: FloatingActionsProps) {
  const router = useRouter();
  const selected = generationImageSelect.useSelection();
  const handleDeselect = () => generationImageSelect.setSelected([]);

  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages({
    onSuccess: () => {
      handleDeselect();
    },
  });

  const handleDeleteImages = () => {
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

  const createPostMuation = trpc.post.create.useMutation();

  const loading = bulkDeleteImagesMutation.isLoading || createPostMuation.isLoading;

  const handlePostImages = async () => {
    const selectedImages = images.filter((x) => selected.includes(x.id));
    const files = (
      await Promise.all(
        selectedImages.map(async (image) => {
          const result = await fetch(image.url);
          if (!result.ok) return;
          const blob = await result.blob();
          const lastIndex = image.url.lastIndexOf('/');
          const name = image.url.substring(lastIndex + 1);
          return new File([blob], name, { type: blob.type });
        })
      )
    ).filter(isDefined);
    if (!files.length) return;
    const post = await createPostMuation.mutateAsync({});
    const pathname = `/posts/${post.id}/edit`;
    await router.push(pathname);
    postImageTransmitter.setData(files);
    generationPanel.close();
    handleDeselect();
  };

  const render = (
    <div style={{ position: 'relative' }}>
      <LoadingOverlay visible={loading} loaderProps={{ variant: 'bars', size: 'sm' }} />
      <Group spacing={6} position="right">
        <Text color="dimmed" size="xs" weight={500} inline>
          {selected.length} selected
        </Text>
        <Group spacing={4}>
          <Tooltip label="Deselect all" {...tooltipProps}>
            <ActionIcon size="md" onClick={handleDeselect} variant="light">
              <IconSquareOff size={20} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete selected" {...tooltipProps}>
            <ActionIcon size="md" onClick={handleDeleteImages} color="red">
              <IconTrash size={20} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Post images" {...tooltipProps}>
            <ActionIcon size="md" variant="light" onClick={handlePostImages}>
              <IconCloudUpload size={20} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Upscale images" {...tooltipProps}>
            <span>
              <ActionIcon size="md" variant="light" disabled>
                <IconWindowMaximize size={20} />
              </ActionIcon>
            </span>
          </Tooltip>
        </Group>
      </Group>
    </div>
  );

  if (children) return children({ selected, render });
  if (!selected.length) return null;

  return render;
}

type FloatingActionsProps = {
  images?: Generation.Image[];
  children?: (args: { selected: number[]; render: JSX.Element }) => React.ReactElement;
};

const useStyles = createStyles((theme) => ({
  grid: {
    display: 'grid',
    gridTemplateRows: 'masonry',
    gap: theme.spacing.xs,
    gridTemplateColumns: '1fr 1fr',

    [`@container (min-width: 530px)`]: {
      gridTemplateColumns: 'repeat(3, 1fr)',
    },
    [`@container (min-width: 900px)`]: {
      gridTemplateColumns: 'repeat(4, 1fr)',
    },
    [`@container (min-width: 1200px)`]: {
      gridTemplateColumns: 'repeat(auto-fill, minmax(256px, 1fr))',
    },
  },
  searchPanel: {
    position: 'absolute',
    top: 4,
    zIndex: 10,
    marginLeft: -4,
    marginRight: -4,
    width: 'calc(100% + 8px)',
  },
}));
