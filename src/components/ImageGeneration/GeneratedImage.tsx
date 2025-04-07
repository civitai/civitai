import {
  ActionIcon,
  Center,
  Checkbox,
  createStyles,
  Menu,
  Modal,
  Text,
  Stack,
  MenuItemProps,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { IntersectionObserverProvider } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { useClipboard, useHotkeys } from '@mantine/hooks';
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
  IconDiamond,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
// import { GeneratedImageLightbox } from '~/components/ImageGeneration/GeneratedImageLightbox';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { orchestratorImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import {
  useGetTextToImageRequestsImages,
  useUpdateImageStepMetadata,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TextToImageQualityFeedbackModal } from '~/components/Modals/GenerationQualityFeedbackModal';
import { UpscaleImageModal } from '~/components/Orchestrator/components/UpscaleImageModal';
import { TwCard } from '~/components/TwCard/TwCard';
import { constants } from '~/server/common/constants';
import { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import {
  getIsFlux,
  getIsSD3,
  getSourceImageFromUrl,
} from '~/shared/constants/generation.constants';
import {
  generationStore,
  useGenerationFormStore,
  useVideoGenerationWorkflows,
} from '~/store/generation.store';
import { trpc } from '~/utils/trpc';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { MediaType } from '~/shared/utils/prisma/enums';
import { BackgroundRemovalModal } from '~/components/Orchestrator/components/BackgroundRemovalModal';
import { UpscaleEnhancementModal } from '~/components/Orchestrator/components/UpscaleEnhancementModal';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { WorkflowDefinitionKey } from '~/server/services/orchestrator/comfy/comfy.types';
import { useGeneratedItemStore } from '~/components/Generation/stores/generated-item.store';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import { EmblaCarouselType } from 'embla-carousel';

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
  const selected = orchestratorImageSelect.useIsSelected({
    workflowId: request.id,
    stepName: step.name,
    imageId: image.id,
  });

  const [nsfwLevelError, setNsfwLevelError] = useState(false);

  const { updateImages } = useUpdateImageStepMetadata();

  const { running, helpers } = useTourContext();

  const toggleSelect = (checked?: boolean) =>
    orchestratorImageSelect.toggle(
      { workflowId: request.id, stepName: step.name, imageId: image.id },
      checked
    );

  const isLightbox = useDialogStore((state) =>
    state.dialogs.some((x) => x.id === 'generated-image')
  );
  const handleImageClick = () => {
    if (!image || !available || isLightbox || nsfwLevelError) return;

    dialogStore.trigger({
      id: 'generated-image',
      component: GeneratedImageLightbox,
      props: { image, request },
    });
  };

  const feedback = step.metadata?.images?.[image.id]?.feedback;
  const isFavorite = step.metadata?.images?.[image.id]?.favorite === true;
  const available = image.status === 'succeeded';

  const [state, setState] = useGeneratedItemStore({
    id: `${request.id}_${step.name}_${image.id}`,
    favorite: step.metadata?.images?.[image.id]?.favorite === true,
    feedback: step.metadata?.images?.[image.id]?.feedback,
  });

  function handleToggleFeedback(newFeedback: 'liked' | 'disliked') {
    const previousState = state;
    setState((state) => ({
      feedback: state.feedback === newFeedback ? undefined : newFeedback,
    }));

    const onError = () => setState(previousState);

    if (state.feedback !== 'disliked' && newFeedback === 'disliked') {
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
    const previousState = state;
    setState({
      favorite: newValue,
    });

    const onError = () => setState(previousState);

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

  return (
    <TwCard
      ref={ref}
      className={clsx('max-h-full max-w-full', classes.imageWrapper)}
      style={{ aspectRatio: image.aspectRatio ?? image.width / image.height }}
    >
      {(isLightbox || inView) && (
        <>
          <div
            className={clsx('relative flex flex-1 flex-col items-center justify-center', {
              ['cursor-pointer']: !isLightbox,
              // ['pointer-events-none']: running,
            })}
            onClick={handleImageClick}
            onMouseDown={(e) => {
              if (e.button === 1) return handleAuxClick(image.url);
            }}
          >
            {nsfwLevelError && (
              <Center px="md">
                <Stack spacing="xs">
                  <Text color="red" weight="bold" align="center" size="sm">
                    Blocked for Adult Content
                  </Text>
                  <Text align="center" size="sm">
                    Private Generation is limited to PG, PG-13 only. Please adjust your prompt and
                    try again.
                  </Text>
                </Stack>
              </Center>
            )}
            <EdgeMedia2
              src={image.url}
              type={image.type}
              alt=""
              className="max-h-full w-auto max-w-full"
              disableWebm
              disablePoster
              onError={(e) => {
                // TODO: We might need a better solution there.
                if (image.url.includes('nsfwLevel')) {
                  setNsfwLevelError(true);
                }
              }}
            />
            <div className="pointer-events-none absolute size-full rounded-md shadow-[inset_0_0_2px_1px_rgba(255,255,255,0.2)]" />
          </div>
          {!isLightbox && !nsfwLevelError && (
            <label className="absolute left-3 top-3" data-tour="gen:select">
              <Checkbox
                className={classes.checkbox}
                checked={selected}
                onChange={(e) => {
                  toggleSelect(e.target.checked);
                  if (running && e.target.checked) helpers?.next();
                }}
              />
            </label>
          )}
          <Menu zIndex={400} withinPortal>
            <Menu.Target>
              <div className="absolute right-3 top-3">
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
              <GeneratedImageWorkflowMenuItems step={step} image={image} workflowId={request.id} />
            </Menu.Dropdown>
          </Menu>

          {!nsfwLevelError && (
            <div
              className={clsx(
                classes.actionsWrapper,
                'absolute bottom-1 left-1 flex flex-wrap items-center gap-1 p-1'
              )}
            >
              <ActionIcon
                size="md"
                className={state.favorite ? classes.favoriteButton : undefined}
                variant={state.favorite ? 'light' : undefined}
                color={state.favorite ? 'red' : undefined}
                onClick={() => handleToggleFavorite(!state.favorite)}
              >
                <IconHeart size={16} />
              </ActionIcon>

              <Menu
                zIndex={400}
                trigger="hover"
                openDelay={100}
                closeDelay={100}
                transition="fade"
                transitionDuration={150}
                withinPortal
                position="top"
              >
                <Menu.Target>
                  <ActionIcon size="md">
                    <IconWand size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown className={classes.improveMenu}>
                  <GeneratedImageWorkflowMenuItems
                    step={step}
                    image={image}
                    workflowId={request.id}
                    workflowsOnly
                  />
                </Menu.Dropdown>
              </Menu>

              <ActionIcon
                size="md"
                variant={state.feedback === 'liked' ? 'light' : undefined}
                color={state.feedback === 'liked' ? 'green' : undefined}
                onClick={() => handleToggleFeedback('liked')}
              >
                <IconThumbUp size={16} />
              </ActionIcon>

              <ActionIcon
                size="md"
                variant={state.feedback === 'disliked' ? 'light' : undefined}
                color={state.feedback === 'disliked' ? 'red' : undefined}
                onClick={() => handleToggleFeedback('disliked')}
              >
                <IconThumbDown size={16} />
              </ActionIcon>
            </div>
          )}
          {!isLightbox && (
            <div className="absolute bottom-2 right-2">
              <ImageMetaPopover
                meta={step.params as any}
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
            </div>
          )}
        </>
      )}
    </TwCard>
  );
}

const useStyles = createStyles((theme, _params, getRef) => {
  const thumbActionRef = getRef('thumbAction');
  const favoriteButtonRef = getRef('favoriteButton');

  const buttonBackground = {
    boxShadow: '0 -2px 6px 1px rgba(0,0,0,0.16)',
    background: theme.fn.rgba(
      theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
      0.6
    ),
  };

  return {
    checkbox: {
      '& input:checked': {
        borderColor: theme.white,
      },
    },
    imageWrapper: {
      [`&:hover .${thumbActionRef}`]: buttonBackground,
      [`&:hover .${thumbActionRef}`]: {
        opacity: 1,
      },
    },
    actionsWrapper: {
      ref: thumbActionRef,
      borderRadius: theme.radius.sm,
      transition: 'opacity .3s',
      ...buttonBackground,
      opacity: 0,

      [`@container (max-width: 420px)`]: {
        width: 68,
        opacity: 1,
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

export function GeneratedImageLightbox({
  image,
  request,
}: {
  image: NormalizedGeneratedImage;
  request: NormalizedGeneratedImageResponse;
}) {
  const dialog = useDialogContext();
  const { steps } = useGetTextToImageRequestsImages();

  const [embla, setEmbla] = useState<EmblaCarouselType | null>(null);
  // useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  const images = steps.flatMap((step) =>
    step.images
      .filter((x) => x.status === 'succeeded')
      .map((image) => ({ ...image, params: { ...step.params, seed: image.seed }, step }))
  );

  const [slide, setSlide] = useState(() => {
    const initialSlide = images.findIndex((item) => item.id === image.id);
    return initialSlide > -1 ? initialSlide : 0;
  });

  return (
    <Modal {...dialog} closeButtonLabel="Close lightbox" fullScreen>
      <IntersectionObserverProvider id="generated-image-lightbox">
        <Embla
          align="center"
          withControls
          controlSize={40}
          startIndex={slide}
          loop
          onSlideChange={setSlide}
          withKeyboardEvents={false}
          setEmbla={setEmbla}
        >
          <Embla.Viewport>
            <Embla.Container className="flex" style={{ height: 'calc(100vh - 84px)' }}>
              {images.map((image, index) => (
                <Embla.Slide
                  key={`${image.workflowId}_${image.id}`}
                  index={index}
                  className="flex flex-[0_0_100%] items-center justify-center"
                >
                  {image.url && (
                    <GeneratedImage
                      image={image} // TODO - fix this
                      request={request}
                      step={image.step}
                    />
                  )}
                </Embla.Slide>
              ))}
            </Embla.Container>
          </Embla.Viewport>
        </Embla>
      </IntersectionObserverProvider>
      <div
        style={{
          position: 'fixed',
          bottom: 0,
          right: 0,
          width: '100%',
          maxWidth: 450,
          zIndex: 10,
        }}
      >
        <GenerationDetails
          label="Generation Details"
          params={images?.[slide]?.params}
          labelWidth={150}
          paperProps={{ radius: 0 }}
          controlProps={{
            sx: (theme) => ({
              backgroundColor:
                theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
            }),
          }}
          upsideDown
        />
      </div>
    </Modal>
  );
}

function GeneratedImageWorkflowMenuItems({
  image,
  step,
  workflowsOnly,
  workflowId,
}: {
  image: NormalizedGeneratedImage;
  step: NormalizedGeneratedImageStep;
  workflowId: string;
  workflowsOnly?: boolean;
}) {
  const { updateImages } = useUpdateImageStepMetadata();
  const { data: workflowDefinitions = [] } = trpc.generation.getWorkflowDefinitions.useQuery();
  const { data: availableEngineConfigurations } = useVideoGenerationWorkflows();

  const { copied, copy } = useClipboard();

  const isVideo = step.$type === 'videoGen';
  const isFlux = !isVideo && getIsFlux(step.params.baseModel);
  const isSD3 = !isVideo && getIsSD3(step.params.baseModel);
  const canImg2Img = !isFlux && !isSD3 && !isVideo;
  const img2imgWorkflows = !isVideo
    ? workflowDefinitions.filter(
        (x) => x.type === 'img2img' && (!canImg2Img ? x.selectable === false : true)
      )
    : [];
  const img2vidConfigs = !isVideo
    ? availableEngineConfigurations.filter((x) => !x.disabled && x.subType === 'img2vid')
    : [];

  const notSelectableMap: Partial<Record<WorkflowDefinitionKey, VoidFunction>> = {
    'img2img-upscale': handleUpscale,
    'img2img-background-removal': handleRemoveBackground,
    'img2img-upscale-enhancement-realism': handleUpscaleEnhance,
  };

  const canRemix = !!step.params.workflow && !(step.params.workflow in notSelectableMap);

  async function handleGenerate(
    { seed, ...rest }: Partial<TextToImageParams> = {},
    {
      type,
      workflow: workflow,
      sourceImage,
      engine,
    }: { type: MediaType; workflow?: string; sourceImage?: string; engine?: string } = {
      type: image.type,
      workflow: step.params.workflow,
    }
  ) {
    handleCloseImageLightbox();
    generationStore.setData({
      resources: step.resources,
      params: { ...(step.params as any), seed, ...rest },
      remixOfId: step.metadata?.remixOfId,
      type,
      workflow: workflow ?? step.params.workflow,
      sourceImage: sourceImage ?? (step.params as any).sourceImage,
      engine: engine ?? (step.params as any).engine,
    });
  }

  async function handleSelectWorkflow(workflow: string) {
    handleGenerate({ workflow, sourceImage: image.url as any }); // TODO - see if there is a good way to handle this type mismatch. We're converting a string to a sourceImage object after we pass the data to the generation store
  }

  async function handleRemoveBackground() {
    dialogStore.trigger({
      component: BackgroundRemovalModal,
      props: {
        workflow: 'img2img-background-removal',
        sourceImage: await getSourceImageFromUrl({ url: image.url }),
      },
    });
  }

  async function handleUpscaleEnhance() {
    dialogStore.trigger({
      component: UpscaleEnhancementModal,
      props: {
        workflow: 'img2img-upscale-enhancement-realism',
        sourceImage: await getSourceImageFromUrl({ url: image.url, upscale: true }),
      },
    });
  }

  async function handleUpscale() {
    if (step.$type !== 'videoGen') {
      dialogStore.trigger({
        component: UpscaleImageModal,
        props: {
          resources: step.resources,
          params: {
            ...step.params,
            sourceImage: await getSourceImageFromUrl({ url: image.url, upscale: true }),
            seed: image.seed,
            workflow: 'img2img-upscale',
          },
        },
      });
    }
  }

  function handleDeleteImage() {
    openConfirmModal({
      title: 'Delete image',
      children:
        'Are you sure that you want to delete this image? This is a destructive action and cannot be undone.',
      labels: { cancel: 'Cancel', confirm: 'Yes, delete it' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        updateImages([
          {
            workflowId,
            stepName: step.name,
            images: {
              [image.id]: {
                hidden: true,
              },
            },
          },
        ]);
        handleCloseImageLightbox();
      },
      zIndex: constants.imageGeneration.drawerZIndex + 2,
      centered: true,
    });
  }

  return (
    <>
      {canRemix && !workflowsOnly && (
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
      {!workflowsOnly && (
        <Menu.Item
          color="red"
          onClick={handleDeleteImage}
          icon={<IconTrash size={14} stroke={1.5} />}
        >
          Delete
        </Menu.Item>
      )}
      {!workflowsOnly && <Menu.Divider />}
      {img2imgWorkflows.map((workflow) => {
        const handleMappedClick = notSelectableMap[workflow.key];
        const handleDefault = () => handleSelectWorkflow(workflow.key);
        const onClick = handleMappedClick ?? handleDefault;
        return (
          <WithMemberMenuItem key={workflow.key} onClick={onClick} memberOnly={workflow.memberOnly}>
            {workflow.name}
          </WithMemberMenuItem>
        );
      })}
      {!!img2imgWorkflows.length && !!img2vidConfigs.length && <Menu.Divider />}
      {!!img2vidConfigs.length && (
        <>
          <Menu.Item
            onClick={() =>
              handleGenerate(
                {},
                {
                  type: 'video',
                  sourceImage: image.url,
                  engine: useGenerationFormStore.getState().engine,
                }
              )
            }
          >
            Image To Video
          </Menu.Item>
        </>
      )}
      {!workflowsOnly && (
        <>
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
            onClick={() => handleAuxClick(image.url)}
          >
            Open in New Tab
          </Menu.Item>
        </>
      )}
    </>
  );
}

function WithMemberMenuItem({
  children,
  memberOnly,
  ...props
}: MenuItemProps & { memberOnly?: boolean; onClick?: VoidFunction }) {
  const currentUser = useCurrentUser();
  return memberOnly && !currentUser?.isPaidMember ? (
    <Tooltip label="Member only">
      <RequireMembership>
        <Menu.Item {...props} className="relative pr-10">
          <span>{children}</span>
          <div className="absolute inset-y-0 right-1 flex items-center">
            <ThemeIcon variant="filled" color="blue" size="md">
              <IconDiamond stroke={2} />
            </ThemeIcon>
          </div>
        </Menu.Item>
      </RequireMembership>
    </Tooltip>
  ) : (
    <Menu.Item {...props}>{children}</Menu.Item>
  );
}

function handleCloseImageLightbox() {
  dialogStore.closeById('generated-image');
}

function handleAuxClick(url: string) {
  window.open(url, '_blank');
}
