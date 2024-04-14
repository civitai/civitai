import {
  ActionIcon,
  AspectRatio,
  Box,
  Button,
  Card,
  Center,
  Checkbox,
  Group,
  Loader,
  Menu,
  Stack,
  Text,
  ThemeIcon,
  createStyles,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
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
  IconThumbDown,
  IconThumbUp,
  IconTrash,
  IconWindowMaximize,
} from '@tabler/icons-react';
import { useRef, useState } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GeneratedImageLightbox } from '~/components/ImageGeneration/GeneratedImageLightbox';
import { generationImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import { useDeleteGenerationRequestImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useInView } from '~/hooks/useInView';
import { constants } from '~/server/common/constants';
import { Generation } from '~/server/services/generation/generation.types';
import { generationStore } from '~/store/generation.store';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { useGenerationQualityFeedback } from './GenerationForm/generation.utils';
import { GENERATION_QUALITY } from '~/server/schema/generation.schema';
import { openGenQualityFeedbackModal } from '../Modals/GenerationQualityFeedbackModal';

export function GeneratedImage({
  image,
  request,
}: {
  image: Generation.Image;
  request: Generation.Request;
}) {
  const { classes } = useStyles();
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const selected = generationImageSelect.useIsSelected(image.id);
  const toggleSelect = (checked?: boolean) => generationImageSelect.toggle(image.id, checked);
  const { copied, copy } = useClipboard();

  const [selectedFeedback, setSelectedFeedback] = useState<GENERATION_QUALITY | null>(null);

  const bulkDeleteImagesMutation = useDeleteGenerationRequestImages();
  const { sendFeedback, sending } = useGenerationQualityFeedback();

  const handleImageClick = () => {
    if (!image || !image.available) return;
    dialogStore.trigger({
      component: GeneratedImageLightbox,
      props: { image, request },
    });
  };

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

  const handleSendFeedback = async ({
    quality,
    message,
  }: {
    quality: GENERATION_QUALITY;
    message?: string;
  }) => {
    if (sending) return;

    setSelectedFeedback(quality);
    await sendFeedback({ jobId: image.hash, reason: quality, message })
      // Error handled in hook
      .catch(() => setSelectedFeedback(null));
  };

  const handleThumbsDownClick = () => {
    openGenQualityFeedbackModal({
      jobId: image.hash,
      onSubmit: () => setSelectedFeedback(GENERATION_QUALITY.BAD),
      onFailed: () => setSelectedFeedback(null),
    });
  };

  const imageRef = useRef<HTMLImageElement>(null);
  const isLandscape = request.params.width > request.params.height;
  const removedForSafety = image.removedForSafety && image.available;

  const badFeedbackSelected = selectedFeedback === GENERATION_QUALITY.BAD;
  const goodFeedbackSelected = selectedFeedback === GENERATION_QUALITY.GOOD;

  if (!image.available) return <></>;

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
            className={classes.imageWrapper}
            style={image.available ? { cursor: 'pointer' } : undefined}
          >
            <Box onClick={handleImageClick}>
              <Box className={classes.innerGlow} />
              {!image.available ? (
                <Center className={classes.centeredAbsolute} p="xs">
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
                <Center className={classes.centeredAbsolute} p="xs">
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
                  icon={<IconArrowsShuffle size={14} stroke={1.5} />}
                >
                  Remix
                </Menu.Item>
                <Menu.Item
                  onClick={handleGenerateWithSeed}
                  icon={<IconPlayerTrackNextFilled size={14} stroke={1.5} />}
                >
                  Remix (with seed)
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
                <Menu.Divider />
                <Menu.Label>System</Menu.Label>
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
              </Menu.Dropdown>
            </Menu>
            {image.available && (
              <Group className={classes.info} w="100%" position="apart">
                <Group spacing={4} className={classes.actionsWrapper}>
                  {(!selectedFeedback || goodFeedbackSelected) && (
                    <ActionIcon
                      size="md"
                      variant={goodFeedbackSelected ? 'light' : undefined}
                      color={goodFeedbackSelected ? 'green' : undefined}
                      onClick={
                        !goodFeedbackSelected
                          ? () => handleSendFeedback({ quality: GENERATION_QUALITY.GOOD })
                          : undefined
                      }
                    >
                      <IconThumbUp size={16} />
                    </ActionIcon>
                  )}
                  {(!selectedFeedback || badFeedbackSelected) && (
                    <ActionIcon
                      size="md"
                      variant={badFeedbackSelected ? 'light' : undefined}
                      color={badFeedbackSelected ? 'red' : undefined}
                      onClick={!badFeedbackSelected ? handleThumbsDownClick : undefined}
                    >
                      <IconThumbDown size={16} />
                    </ActionIcon>
                  )}
                </Group>
                <ImageMetaPopover
                  meta={request.params}
                  zIndex={constants.imageGeneration.drawerZIndex + 1}
                  hideSoftware
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
          </Card>
        </>
      )}
    </AspectRatio>
  );
}

export function GenerationPlaceholder({ request }: { request: Generation.Request }) {
  const { classes } = useStyles();

  return (
    <AspectRatio ratio={request.params.width / request.params.height}>
      <Card p={0} className={classes.imageWrapper}>
        <Box className={classes.innerGlow} />
        <Center className={classes.centeredAbsolute} p="xs">
          <Stack align="center">
            <Loader size={24} />
            <Text color="dimmed" size="xs" align="center">
              Generating
            </Text>
          </Stack>
        </Center>
      </Card>
    </AspectRatio>
  );
}

const useStyles = createStyles((theme, _params, getRef) => {
  const thumbActionRef = getRef('thumbAction');

  return {
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
    imageWrapper: {
      position: 'relative',
      boxShadow:
        '0 1px 3px rgba(0, 0, 0, .5), 0px 20px 25px -5px rgba(0, 0, 0, 0.2), 0px 10px 10px -5px rgba(0, 0, 0, 0.04)',
      width: '100%',
      height: '100%',
      background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
      [`&:hover .${thumbActionRef}`]: {
        opacity: 1,
        transition: 'opacity .3s',
      },
    },
    centeredAbsolute: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    innerGlow: {
      display: 'block',
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      boxShadow: 'inset 0px 0px 2px 1px rgba(255,255,255,0.2)',
      borderRadius: theme.radius.sm,
      pointerEvents: 'none',
    },
    actionsWrapper: {
      ref: thumbActionRef,
      borderRadius: theme.radius.sm,
      background: theme.fn.rgba(
        theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
        0.6
      ),
      // backdropFilter: 'blur(5px) saturate(160%)',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
      padding: 4,
      opacity: 0,
      transition: 'opacity .3s',

      [theme.fn.smallerThan('sm')]: {
        opacity: 0.7,
      },
    },
  };
});
