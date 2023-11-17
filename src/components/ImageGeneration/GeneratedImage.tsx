import {
  AspectRatio,
  Loader,
  Center,
  Card,
  Text,
  Stack,
  Group,
  Checkbox,
  ActionIcon,
  Tooltip,
  TooltipProps,
  Box,
  Menu,
} from '@mantine/core';
import { openConfirmModal, openContextModal } from '@mantine/modals';
import {
  IconAdjustments,
  IconArrowsShuffle,
  IconDotsVertical,
  IconHourglass,
  IconInfoCircle,
  IconPlayerPlayFilled,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { useInView } from 'react-intersection-observer';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import { Generation, GenerationRequestStatus } from '~/server/services/generation/generation.types';
import { generationStore } from '~/store/generation.store';
import { constants } from '~/server/common/constants';
import { useDeleteGenerationRequestImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';

// type GeneratedImageStatus = 'loading' | 'loaded' | 'error';

export function GeneratedImage({
  image,
  request,
}: {
  image: Generation.Image;
  request: Generation.Request;
}) {
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const selected = generationImageSelect.useSelected(image.id);
  const toggleSelect = (checked?: boolean) => generationImageSelect.toggle(image.id, checked);

  const handleImageClick = () => {
    if (!image || !image.available) return;
    openContextModal({
      modal: 'generatedImageLightbox',
      zIndex: 400,
      transitionDuration: 200,
      fullScreen: true,
      closeButtonLabel: 'Close lightbox',
      innerProps: {
        image,
        request,
      },
    });
  };

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
    <AspectRatio ratio={request.params.width / request.params.height} ref={ref}>
      {inView && (
        <>
          {/* TODO - move this to new dialog trigger */}
          {/* <CreateVariantsModal
            opened={state.variantModalOpened}
            onClose={() =>
              setState((current) => ({ ...current, variantModalOpened: false, selectedItems: [] }))
            }
          /> */}
          <Card p={0}>
            <Box
              onClick={handleImageClick}
              sx={(theme) => ({
                position: 'relative',
                boxShadow:
                  '0 2px 3px rgba(0, 0, 0, .5), 0px 20px 25px -5px rgba(0, 0, 0, 0.2), 0px 10px 10px -5px rgba(0, 0, 0, 0.04)',
                cursor: 'pointer',
                [`&::after`]: {
                  content: '""',
                  display: 'block',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  boxShadow: 'inset 0px 0px 2px 1px rgba(255,255,255,0.2)',
                  borderRadius: theme.radius.sm,
                },
              })}
            >
              {!image.available ? (
                <Center
                  sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}
                  p="xs"
                >
                  {request.status === GenerationRequestStatus.Pending && (
                    <Stack align="center">
                      <IconHourglass />
                      <Text color="dimmed" size="xs">
                        Queued
                      </Text>
                    </Stack>
                  )}
                  {request.status === GenerationRequestStatus.Processing && (
                    <Stack align="center">
                      <Loader size={24} />
                      <Text color="dimmed" size="xs" align="center">
                        Generating
                      </Text>
                    </Stack>
                  )}
                  {request.status === GenerationRequestStatus.Error && (
                    <Text color="dimmed" size="xs" align="center">
                      Could not load image
                    </Text>
                  )}
                </Center>
              ) : (
                // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
                <img alt="" src={image.url} style={{ zIndex: 2, width: '100%' }} />
              )}
            </Box>
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
              onChange={(e) => {
                toggleSelect(e.target.checked);
              }}
            />
            <Menu withinPortal>
              <Menu.Target>
                <ActionIcon
                  variant="transparent"
                  p={0}
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  sx={(theme) => ({
                    width: 30,
                    position: 'absolute',
                    top: theme.spacing.xs,
                    right: theme.spacing.xs,
                  })}
                >
                  <IconDotsVertical
                    size={26}
                    color="#fff"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                  />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={handleGenerate}
                  icon={<IconPlayerPlayFilled size={14} stroke={1.5} />}
                >
                  Generate
                </Menu.Item>
                <Menu.Item
                  color="red"
                  onClick={handleDeleteImage}
                  icon={<IconTrash size={14} stroke={1.5} />}
                >
                  Delete
                </Menu.Item>
                <Menu.Divider />
                <Menu.Label>Coming soon</Menu.Label>
                <Menu.Item disabled icon={<IconArrowsShuffle size={14} stroke={1.5} />}>
                  Create variant
                </Menu.Item>
                <Menu.Item disabled icon={<IconWindowMaximize size={14} stroke={1.5} />}>
                  Upscale
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Box
              sx={(theme) => ({
                bottom: theme.spacing.xs,
                right: theme.spacing.xs,
                position: 'absolute',
              })}
            >
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
            </Box>
          </Card>
        </>
      )}
    </AspectRatio>
  );
}
