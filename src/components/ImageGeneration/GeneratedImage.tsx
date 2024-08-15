import { ActionIcon, Checkbox, createStyles, Group, Loader, Menu, Text } from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArrowsShuffle,
  IconCheck,
  IconDotsVertical,
  IconExternalLink,
  IconInfoCircle,
  IconInfoHexagon,
  IconPlayerTrackNextFilled,
  IconThumbDown,
  IconThumbUp,
  IconTrash,
  IconWand,
  IconHeart,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState, useRef } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { GeneratedImageLightbox } from '~/components/ImageGeneration/GeneratedImageLightbox';
import { orchestratorImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import { useUpdateImageStepMetadata } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TextToImageQualityFeedbackModal } from '~/components/Modals/GenerationQualityFeedbackModal';
import { UpscaleImageModal } from '~/components/Orchestrator/components/UpscaleImageModal';
import images from '~/pages/api/v1/images';
import { constants } from '~/server/common/constants';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import { getIsFlux } from '~/shared/constants/generation.constants';
import { generationStore, useGenerationStore } from '~/store/generation.store';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { trpc } from '~/utils/trpc';

export type GeneratedImageProps = {
  image: NormalizedGeneratedImage;
  request: NormalizedGeneratedImageResponse;
  step: NormalizedGeneratedImageStep;
};

export function GeneratedImage({
  image,
  request,
  step,
}: {
  image: NormalizedGeneratedImage;
  request: NormalizedGeneratedImageResponse;
  step: NormalizedGeneratedImageStep;
}) {
  const { classes } = useStyles();
  const [ref, inView] = useInViewDynamic({ id: image.id });
  // const { ref, inView, sizeMapping } = useIntersectionObserverContext({ id: image.id });
  // const { ref, inView } = useInView({ rootMargin: '600px' });
  const selected = orchestratorImageSelect.useIsSelected({
    workflowId: request.id,
    stepName: step.name,
    imageId: image.id,
  });
  const { pathname } = useRouter();
  const view = useGenerationStore((state) => state.view);

  const { updateImages, isLoading } = useUpdateImageStepMetadata();
  const { data: workflowDefinitions } = trpc.generation.getWorkflowDefinitions.useQuery();
  const img2imgWorkflows = workflowDefinitions?.filter((x) => x.type === 'img2img');

  // if (request.id.indexOf('-') !== request.id.lastIndexOf('-')) {
  //   console.log({ workflowId: request.id, stepName: step.name, imageId: image.id, selected });
  // }

  const toggleSelect = (checked?: boolean) =>
    orchestratorImageSelect.toggle(
      {
        workflowId: request.id,
        stepName: step.name,
        imageId: image.id,
      },
      checked
    );
  const { copied, copy } = useClipboard();

  const handleImageClick = () => {
    if (!image || !available) return;

    dialogStore.trigger({
      component: GeneratedImageLightbox,
      props: { image, request },
    });
  };

  const handleAuxClick = () => {
    if (image) window.open(image.url, '_blank');
  };

  const handleGenerate = ({ seed, ...rest }: Partial<TextToImageParams> = {}) => {
    generationStore.setData({
      resources: step.resources,
      params: { ...step.params, seed, ...rest },
      remixOfId: step.metadata?.remixOfId,
      view: !pathname.includes('/generate') ? 'generate' : view,
    });
  };

  const handleSelectWorkflow = (workflow: string) => handleGenerate({ workflow, image: image.url });

  const handleDeleteImage = () => {
    openConfirmModal({
      title: 'Delete image',
      children:
        'Are you sure that you want to delete this image? This is a destructive action and cannot be undone.',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete it' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        updateImages([
          {
            workflowId: request.id,
            stepName: step.name,
            images: {
              [image.id]: {
                hidden: true,
              },
            },
          },
        ]),
      zIndex: constants.imageGeneration.drawerZIndex + 2,
      centered: true,
    });
  };

  const handleUpscale = (workflow: string) => {
    dialogStore.trigger({
      component: UpscaleImageModal,
      props: {
        resources: step.resources,
        params: {
          ...step.params,
          image: image.url,
          seed: image.seed ?? step.params.seed,
          workflow,
        },
      },
    });
  };

  const imageRef = useRef<HTMLImageElement>(null);

  const feedback = step.metadata?.images?.[image.id]?.feedback;
  const isFavorite = step.metadata?.images?.[image.id]?.favorite === true;
  const available = image.status === 'succeeded';

  const [buttonState, setButtonState] = useState({
    favorite: isFavorite,
    feedback,
  });

  function handleToggleFeedback(newFeedback: 'liked' | 'disliked') {
    setButtonState({
      ...buttonState,
      feedback: feedback === newFeedback ? undefined : newFeedback,
    });

    function onError() {
      setButtonState({ ...buttonState, feedback });
    }

    if (feedback !== 'disliked' && newFeedback === 'disliked') {
      dialogStore.trigger({
        component: TextToImageQualityFeedbackModal,
        props: {
          workflowId: request.id,
          imageId: image.id,
          comments: step.metadata?.images?.[image.id]?.comments,
          stepName: step.name,
        },
      });
    }

    updateImages(
      [
        {
          workflowId: request.id,
          stepName: step.name,
          images: {
            [image.id]: {
              feedback: newFeedback,
            },
          },
        },
      ],
      onError
    );
  }

  function handleToggleFavorite(newValue: true | false) {
    setButtonState({ ...buttonState, favorite: newValue });

    function onError() {
      setButtonState({ ...buttonState, favorite: isFavorite });
    }

    updateImages(
      [
        {
          workflowId: request.id,
          stepName: step.name,
          images: {
            [image.id]: {
              favorite: newValue,
            },
          },
        },
      ],
      onError
    );
  }

  if (!available) return <></>;

  const isFlux = getIsFlux(step.params.baseModel);
  const canRemix = !isFlux && step.params.workflow !== 'img2img-upscale';
  const { params } = step;

  return (
    <div
      ref={ref}
      className={`size-full shadow-inner card ${classes.imageWrapper}`}
      style={{ aspectRatio: params.width / params.height }}
    >
      {inView && (
        <>
          <div
            className={`flex flex-1 cursor-pointer flex-col items-center justify-center`}
            onClick={handleImageClick}
            onMouseDown={(e) => {
              if (e.button === 1) return handleAuxClick();
            }}
          >
            <div className={classes.innerGlow} />
            {/* eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element */}
            <img
              ref={imageRef}
              alt=""
              src={image.url}
              style={{ zIndex: 2, width: '100%' }}
              onDragStart={(e) => {
                if (image.url) e.dataTransfer.setData('text/uri-list', image.url);
              }}
            />
          </div>
          <label className="absolute left-3 top-3 z-10">
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
              <div className="absolute right-3 top-3 z-10">
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
              {canRemix && (
                <>
                  <Menu.Item
                    onClick={() => handleGenerate()}
                    icon={<IconArrowsShuffle size={14} stroke={1.5} />}
                  >
                    Remix
                  </Menu.Item>
                  <Menu.Item
                    onClick={() => handleGenerate({ seed: image.seed })}
                    icon={<IconPlayerTrackNextFilled size={14} stroke={1.5} />}
                  >
                    Remix (with seed)
                  </Menu.Item>
                </>
              )}
              <Menu.Item
                color="red"
                onClick={handleDeleteImage}
                icon={<IconTrash size={14} stroke={1.5} />}
              >
                Delete
              </Menu.Item>
              {!!img2imgWorkflows?.length && canRemix && (
                <>
                  <Menu.Divider />
                  <Menu.Label>Image-to-image workflows</Menu.Label>
                  {img2imgWorkflows?.map((workflow) => (
                    <Menu.Item
                      key={workflow.key}
                      onClick={() => {
                        if (workflow.key === 'img2img-upscale') handleUpscale(workflow.key);
                        else handleSelectWorkflow(workflow.key);
                      }}
                    >
                      {workflow.name}
                    </Menu.Item>
                  ))}
                </>
              )}
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
                onClick={() => copy(image.jobId)}
              >
                Copy Job ID
              </Menu.Item>
              <Menu.Item
                icon={<IconExternalLink size={14} stroke={1.5} />}
                onClick={handleAuxClick}
              >
                Open in New Tab
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>

          <Group className={classes.info} w="100%" position="apart">
            <Group spacing={4} className={classes.actionsWrapper}>
              <ActionIcon
                size="md"
                className={buttonState.favorite ? classes.favoriteButton : undefined}
                variant={buttonState.favorite ? 'light' : undefined}
                color={buttonState.favorite ? 'red' : undefined}
                onClick={() => handleToggleFavorite(!buttonState.favorite)}
              >
                <IconHeart size={16} />
              </ActionIcon>

              {!!img2imgWorkflows?.length && canRemix && (
                <Menu
                  zIndex={400}
                  trigger="hover"
                  openDelay={100}
                  closeDelay={100}
                  transition="fade"
                  transitionDuration={150}
                >
                  <Menu.Target>
                    <ActionIcon size="md">
                      <IconWand size={16} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown className={classes.improveMenu}>
                    {img2imgWorkflows?.map((workflow) => (
                      <Menu.Item
                        key={workflow.key}
                        onClick={() => {
                          if (workflow.key === 'img2img-upscale') handleUpscale(workflow.key);
                          else handleSelectWorkflow(workflow.key);
                        }}
                      >
                        {workflow.name}
                      </Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )}

              <ActionIcon
                size="md"
                variant={buttonState.feedback === 'liked' ? 'light' : undefined}
                color={buttonState.feedback === 'liked' ? 'green' : undefined}
                onClick={() => handleToggleFeedback('liked')}
              >
                <IconThumbUp size={16} />
              </ActionIcon>

              <ActionIcon
                size="md"
                variant={buttonState.feedback === 'disliked' ? 'light' : undefined}
                color={buttonState.feedback === 'disliked' ? 'red' : undefined}
                onClick={() => handleToggleFeedback('disliked')}
              >
                <IconThumbDown size={16} />
              </ActionIcon>
            </Group>
            <ImageMetaPopover
              meta={step.params}
              zIndex={constants.imageGeneration.drawerZIndex + 1}
              hideSoftware
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
        </>
      )}
    </div>
  );
}

export function GenerationPlaceholder({ width, height }: { width: number; height: number }) {
  return (
    <div
      className="flex flex-col items-center justify-center border card"
      style={{ aspectRatio: width / height }}
    >
      <Loader size={24} />
      <Text color="dimmed" size="xs" align="center">
        Generating
      </Text>
    </div>
  );
}

const useStyles = createStyles((theme, _params, getRef) => {
  const thumbActionRef = getRef('thumbAction');
  const favoriteButtonRef = getRef('favoriteButton');

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
      zIndex: 2,
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
      background: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
      [`&:hover .${thumbActionRef}`]: {
        boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
        background: theme.fn.rgba(
          theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
          0.6
        ),
      },
      [`&:hover .${thumbActionRef} button`]: {
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
      zIndex: 10,
    },
    actionsWrapper: {
      ref: thumbActionRef,
      borderRadius: theme.radius.sm,
      padding: 4,
      transition: 'opacity .3s',

      ['button']: {
        opacity: 0,

        [`&.${favoriteButtonRef}`]: {
          opacity: 1,
        },

        [theme.fn.smallerThan('sm')]: {
          opacity: 0.7,
        },
      },
    },

    favoriteButton: {
      ref: favoriteButtonRef,
      background: 'rgba(240, 62, 62, 0.5)',
    },

    improveMenu: {
      borderRadius: theme.radius.sm,
      background: theme.fn.rgba(
        theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
        0.8
      ),
      border: 'none',
      boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
      padding: 4,
    },
  };
});
