import { Paper, Checkbox, Card, ActionIcon, Group, Tooltip, TooltipProps } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconAdjustments,
  IconArrowsShuffle,
  IconInfoCircle,
  IconPlayerPlayFilled,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { GeneratedImage } from '~/components/ImageGeneration/GeneratedImage';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
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
  // selected,
  // onCheckboxClick,
  onCreateVariantClick,
}: Props) {
  const selected = generationImageSelect.useIsSelected(image.id);
  const toggleSelect = (checked?: boolean) => generationImageSelect.toggle(image.id, checked);
  const [showActions, setShowActions] = useSessionStorage<boolean>({
    key: 'showAllActions',
    defaultValue: false,
    getInitialValueInEffect: true,
  });

  const toggle = () => setShowActions((prev) => !prev);
  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages();

  const handleGenerate = () => {
    generationStore.setData({
      type: 'remix',
      data: { ...request, params: { ...request.params, seed: image.seed ?? request.params.seed } },
    });
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
        alignSelf: 'flex-start',
      })}
    >
      <GeneratedImage request={request} image={image} />
      <Checkbox
        sx={(theme) => ({
          position: 'absolute',
          top: theme.spacing.xs,
          left: theme.spacing.xs,
          zIndex: 3,

          '& input:checked': {
            borderColor: theme.white,
          },
        })}
        checked={selected}
        onChange={(event) => {
          toggleSelect(event.target.checked);
          // onCheckboxClick({ image, checked: event.target.checked });
          setShowActions(false);
        }}
      />
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
        <Card
          p={0}
          sx={{
            // backdropFilter: 'blur(3px)',
            backgroundColor: 'rgba(0,0,0,0.6)',
            boxShadow:
              'inset 0px 0px 1px 1px rgba(255,255,255,0.1), 0 2px 3px rgba(0, 0, 0, .5), 0px 20px 25px -5px rgba(0, 0, 0, 0.2), 0px 10px 10px -5px rgba(0, 0, 0, 0.04)',
          }}
        >
          <Group spacing={0} noWrap>
            <ActionIcon variant="light" p={4} onClick={toggle} radius={0}>
              <IconAdjustments />
            </ActionIcon>
            {showActions && (
              <Group spacing={0} noWrap>
                <Tooltip {...tooltipProps} label="Generate">
                  <ActionIcon p={4} variant="light" radius={0} onClick={handleGenerate}>
                    <IconPlayerPlayFilled />
                  </ActionIcon>
                </Tooltip>
                <Tooltip {...tooltipProps} label="Delete">
                  <ActionIcon
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
                      p={4}
                      variant="light"
                      onClick={() => onCreateVariantClick?.(image)}
                      radius={0}
                      style={{ background: 'none', border: 'none' }}
                      disabled
                    >
                      <IconArrowsShuffle />
                    </ActionIcon>
                  </span>
                </Tooltip>
                <Tooltip {...tooltipProps} label="Upscale">
                  <span>
                    <ActionIcon
                      p={4}
                      variant="light"
                      radius={0}
                      style={{ background: 'none', border: 'none' }}
                      disabled
                    >
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
    </Paper>
  );
}

type Props = {
  image: Generation.Image;
  request: Generation.Request;
  // selected: boolean;
  // onCheckboxClick: (data: { image: Generation.Image; checked: boolean }) => void;
  onCreateVariantClick?: (image: Generation.Image) => void;
};
