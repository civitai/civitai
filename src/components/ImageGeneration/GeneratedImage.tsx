import {
  AspectRatio,
  Loader,
  Center,
  Card,
  Text,
  Stack,
  Checkbox,
  ActionIcon,
  Box,
  Menu,
  createStyles,
  ThemeIcon,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { useClipboard } from '@mantine/hooks';
import {
  IconArrowsShuffle,
  IconBan,
  IconCheck,
  IconDotsVertical,
  IconHourglass,
  IconInfoCircle,
  IconInfoHexagon,
  IconPlayerPlayFilled,
  IconPlayerTrackNextFilled,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import { Generation } from '~/server/services/generation/generation.types';
import { generationStore } from '~/store/generation.store';
import { constants } from '~/server/common/constants';
import { useDeleteGenerationRequestImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useInView } from '~/hooks/useInView';
import { useRef } from 'react';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GeneratedImageLightbox } from '~/components/ImageGeneration/GeneratedImageLightbox';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function GeneratedImage({
  image,
  request,
  fullCoverage = false,
}: {
  image: Generation.Image;
  request: Generation.Request;
  fullCoverage?: boolean;
}) {
  const { classes } = useStyles();
  const user = useCurrentUser();
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const selected = generationImageSelect.useSelected(image.id);
  const toggleSelect = (checked?: boolean) => generationImageSelect.toggle(image.id, checked);
  const { copied, copy } = useClipboard();

  const handleImageClick = () => {
    if (!image || !image.available) return;
    dialogStore.trigger({
      component: GeneratedImageLightbox,
      props: { image, request },
    });
  };

  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages();

  const handleGenerate = () => {
    const { resources, params } = request;
    generationStore.setData({
      type: 'remix',
      data: { resources, params: { ...params, seed: undefined } },
    });
  };

  const handleGenerateWithSeed = () => {
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

  const imageRef = useRef<HTMLImageElement>(null);
  const isLandscape = request.params.width > request.params.height;
  const removedForSafety = image.removedForSafety && image.available && !fullCoverage;
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
          <Card
            p={0}
            sx={(theme) => ({
              position: 'relative',
              boxShadow:
                '0 1px 3px rgba(0, 0, 0, .5), 0px 20px 25px -5px rgba(0, 0, 0, 0.2), 0px 10px 10px -5px rgba(0, 0, 0, 0.04)',
              cursor: image.available ? 'pointer' : undefined,
              width: '100%',
              height: '100%',
              background:
                theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
            })}
          >
            <Box onClick={handleImageClick}>
              <Box
                sx={(theme) => ({
                  display: 'block',
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  boxShadow: 'inset 0px 0px 2px 1px rgba(255,255,255,0.2)',
                  borderRadius: theme.radius.sm,
                })}
              />
              {!image.available ? (
                <Center
                  sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                  }}
                  p="xs"
                >
                  {image.status === 'Started' ? (
                    <Stack align="center">
                      <Loader size={24} />
                      <Text color="dimmed" size="xs" align="center">
                        Generating
                      </Text>
                    </Stack>
                  ) : image.status === 'Error' ? (
                    <Text color="dimmed" size="xs" align="center">
                      Could not load image
                    </Text>
                  ) : (
                    <Stack align="center">
                      <IconHourglass />
                      <Text color="dimmed" size="xs">
                        Queued
                      </Text>
                    </Stack>
                  )}
                </Center>
              ) : removedForSafety ? (
                <Center
                  sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                  }}
                  p="xs"
                >
                  <Stack align="center" spacing={0}>
                    <Box
                      className={classes.blockedMessage}
                      sx={{
                        flexDirection: isLandscape ? 'row' : 'column',
                      }}
                    >
                      <ThemeIcon
                        color="red"
                        size={isLandscape ? 36 : 48}
                        className={classes.iconBlocked}
                        radius="xl"
                        variant="light"
                        sx={(theme) => ({
                          marginBottom: isLandscape ? 0 : theme.spacing.sm,
                          marginRight: isLandscape ? theme.spacing.sm : 0,
                        })}
                      >
                        <IconBan size={isLandscape ? 24 : 36} />
                      </ThemeIcon>
                      <Stack spacing={0} align={isLandscape ? undefined : 'center'}>
                        <Text
                          color="red.5"
                          weight={500}
                          size="sm"
                          align="center"
                          sx={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
                        >
                          Blocked by Provider
                        </Text>
                        <Text
                          size="xs"
                          component="a"
                          td="underline"
                          color="dimmed"
                          href="/blocked-by-provider"
                          target="_blank"
                        >
                          Why?
                        </Text>
                      </Stack>
                    </Box>
                  </Stack>
                </Center>
              ) : (
                // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
                <img
                  ref={imageRef}
                  alt=""
                  src={image.url}
                  style={{ zIndex: 2, width: '100%' }}
                  onDragStart={(e) => e.dataTransfer.setData('text/uri-list', image.url)}
                />
              )}
            </Box>
            <label className={classes.checkboxLabel}>
              <Checkbox
                className={classes.checkbox}
                checked={selected}
                onChange={(e) => {
                  toggleSelect(e.target.checked);
                }}
              />
            </label>
            <Menu zIndex={400} withinPortal>
              <Menu.Target>
                <div className={classes.menuTarget}>
                  <ActionIcon variant="transparent">
                    <IconDotsVertical
                      size={26}
                      color="#fff"
                      filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                    />
                  </ActionIcon>
                </div>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item
                  onClick={handleGenerate}
                  icon={<IconPlayerPlayFilled size={14} stroke={1.5} />}
                >
                  Generate
                </Menu.Item>
                <Menu.Item
                  onClick={handleGenerateWithSeed}
                  icon={<IconPlayerTrackNextFilled size={14} stroke={1.5} />}
                >
                  Generate (with seed)
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
                {user?.isModerator && (
                  <>
                    <Menu.Divider />
                    <Menu.Label>Moderator</Menu.Label>
                    <Menu.Item
                      icon={
                        copied ? (
                          <IconCheck size={14} stroke={1.5} />
                        ) : (
                          <IconInfoHexagon size={14} stroke={1.5} />
                        )
                      }
                      onClick={() => copy(image.hash)}
                    >
                      Copy Job ID
                    </Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
            <ImageMetaPopover
              meta={request.params}
              zIndex={constants.imageGeneration.drawerZIndex + 1}
              // generationProcess={image.generationProcess ?? undefined} // TODO.generation - determine if we will be returning the image generation process
            >
              <div className={classes.info}>
                <ActionIcon variant="transparent" size="md">
                  <IconInfoCircle
                    color="white"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                    opacity={0.8}
                    strokeWidth={2.5}
                    size={26}
                  />
                </ActionIcon>
              </div>
            </ImageMetaPopover>
          </Card>
        </>
      )}
    </AspectRatio>
  );
}

const useStyles = createStyles((theme) => ({
  checkboxLabel: {
    position: 'absolute',
    top: 0,
    left: 0,
    padding: theme.spacing.xs,
    cursor: 'pointer',
  },
  checkbox: {
    '& input:checked': {
      borderColor: theme.white,
    },
  },
  menuTarget: {
    position: 'absolute',
    top: 0,
    right: 0,
    padding: theme.spacing.xs,
    cursor: 'pointer',
  },
  info: {
    bottom: 0,
    right: 0,
    padding: theme.spacing.xs,
    position: 'absolute',
    cursor: 'pointer',
  },
  iconBlocked: {
    [containerQuery.smallerThan(380)]: {
      display: 'none',
    },
  },
  mistake: {
    [containerQuery.largerThan(380)]: {
      marginTop: theme.spacing.sm,
    },
  },
  blockedMessage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
