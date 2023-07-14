import {
  Paper,
  Checkbox,
  AspectRatio,
  Card,
  ActionIcon,
  Group,
  Tooltip,
  TooltipProps,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowsShuffle,
  IconBolt,
  IconInfoCircle,
  IconPlayerPlayFilled,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { useDeleteGenerationRequestImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { constants } from '~/server/common/constants';
import { Generation } from '~/server/services/generation/generation.types';
import { generationStore } from '~/store/generation.store';

const tooltipProps: Omit<TooltipProps, 'children' | 'label'> = {
  withinPortal: true,
  withArrow: true,
  color: 'dark',
  zIndex: constants.imageGeneration.drawerZIndex + 1,
};

export function FeedItem({
  image,
  request,
  selected,
  onCheckboxClick,
  onCreateVariantClick,
}: Props) {
  const [opened, { toggle, close }] = useDisclosure();

  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages();

  const handleGenerate = () => {
    generationStore.setData({ type: 'remix', data: request });
  };

  const handleDeleteImage = () => {
    openConfirmModal({
      title: 'Delete image',
      children:
        'Are you sure that you want to delete this image? This is a destructive action and cannot be undone.',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete it' },
      confirmProps: { color: 'red' },
      onConfirm: () => bulkDeleteImagesMutation.mutate({ ids: [image.id] }),
      zIndex: constants.imageGeneration.drawerZIndex + 2,
      centered: true,
    });
  };

  return (
    <Paper
      key={image.id}
      radius="sm"
      sx={(theme) => ({
        position: 'relative',
        // If the item is selected, we want to add an overlay to it
        '&::after': selected
          ? {
              content: '""',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: theme.fn.rgba(theme.colors.blue[theme.fn.primaryShade()], 0.3),
            }
          : undefined,
      })}
    >
      <AspectRatio ratio={1}>
        <GeneratedImage request={request} image={image} />
      </AspectRatio>
      <Checkbox
        sx={(theme) => ({
          position: 'absolute',
          top: theme.spacing.xs,
          left: theme.spacing.xs,
          zIndex: 3,
        })}
        checked={selected}
        onChange={(event) => {
          onCheckboxClick({ image, checked: event.target.checked });
          close();
        }}
      />
      {!selected && (
        <Group
          position="apart"
          sx={(theme) => ({
            bottom: 0,
            left: 0,
            padding: theme.spacing.xs,
            position: 'absolute',
            width: '100%',
            overflow: 'hidden',
            zIndex: 3,
          })}
        >
          <Card p={0} withBorder>
            <Group spacing={0} noWrap>
              <ActionIcon size="md" variant="light" p={4} onClick={toggle} radius={0}>
                <IconBolt />
              </ActionIcon>
              {opened && (
                <Group spacing={0} noWrap>
                  <Tooltip {...tooltipProps} label="Generate">
                    <ActionIcon size="md" p={4} variant="light" radius={0} onClick={handleGenerate}>
                      <IconPlayerPlayFilled />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip {...tooltipProps} label="Delete">
                    <ActionIcon
                      size="md"
                      p={4}
                      color="red"
                      radius={0}
                      onClick={handleDeleteImage}
                      loading={bulkDeleteImagesMutation.isLoading}
                    >
                      <IconTrash />
                    </ActionIcon>
                  </Tooltip>

                  <Tooltip {...tooltipProps} label="Create variant">
                    <span>
                      <ActionIcon
                        size="md"
                        p={4}
                        variant="light"
                        onClick={() => onCreateVariantClick(image)}
                        radius={0}
                        disabled
                      >
                        <IconArrowsShuffle />
                      </ActionIcon>
                    </span>
                  </Tooltip>
                  <Tooltip {...tooltipProps} label="Upscale">
                    <span>
                      <ActionIcon size="md" p={4} variant="light" radius={0} disabled>
                        <IconWindowMaximize />
                      </ActionIcon>
                    </span>
                  </Tooltip>
                </Group>
              )}
            </Group>
          </Card>

          <ImageMetaPopover
            meta={request.params}
            zIndex={constants.imageGeneration.drawerZIndex + 1}
            // generationProcess={image.generationProcess ?? undefined} // TODO.generation - determine if we will be returning the image generation process
          >
            <ActionIcon variant="transparent" size="md">
              <IconInfoCircle
                color="white"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                opacity={0.8}
                strokeWidth={2.5}
                size={26}
              />
            </ActionIcon>
          </ImageMetaPopover>
        </Group>
      )}
    </Paper>
  );
}

type Props = {
  image: Generation.Image;
  request: Generation.Request;
  selected: boolean;
  onCheckboxClick: (data: { image: any; checked: boolean }) => void;
  onCreateVariantClick: (image: any) => void;
};
