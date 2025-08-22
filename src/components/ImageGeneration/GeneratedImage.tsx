import type { MenuItemProps } from '@mantine/core';
import {
  ActionIcon,
  Center,
  Checkbox,
  Menu,
  Modal,
  Text,
  Stack,
  ThemeIcon,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
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
import type { DragEvent } from 'react';
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
import type { TextToImageParams } from '~/server/schema/orchestrator/textToImage.schema';
import type {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import {
  getIsFlux,
  getIsHiDream,
  getIsQwen,
  getIsSD3,
} from '~/shared/constants/generation.constants';
import { generationStore, useGenerationFormStore } from '~/store/generation.store';
import { trpc } from '~/utils/trpc';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { BackgroundRemovalModal } from '~/components/Orchestrator/components/BackgroundRemovalModal';
import { UpscaleEnhancementModal } from '~/components/Orchestrator/components/UpscaleEnhancementModal';
import { EnhanceVideoModal } from '~/components/Orchestrator/components/EnhanceVideoModal';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { WorkflowDefinitionKey } from '~/server/services/orchestrator/comfy/comfy.types';
import { useGeneratedItemStore } from '~/components/Generation/stores/generated-item.store';
import { RequireMembership } from '~/components/RequireMembership/RequireMembership';
import { Embla } from '~/components/EmblaCarousel/EmblaCarousel';
import type { EmblaCarouselType } from 'embla-carousel';
import { getStepMeta } from './GenerationForm/generation.utils';
import { mediaDropzoneData } from '~/store/post-image-transmitter.store';
import classes from './GeneratedImage.module.css';
import { useGenerationEngines } from '~/components/Generation/Video/VideoGenerationProvider';
import { capitalize } from '~/utils/string-helpers';
import { NextLink } from '~/components/NextLink/NextLink';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { getModelVersionUsesImageGen } from '~/shared/orchestrator/ImageGen/imageGen.config';
import {
  getIsFluxContextFromEngine,
  getIsFluxKontext,
} from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NsfwLevel } from '@civitai/client';
import { getSourceImageFromUrl } from '~/utils/image-utils';

export type GeneratedImageProps = {
  image: NormalizedGeneratedImage;
  request: Omit<NormalizedGeneratedImageResponse, 'steps'>;
  step: NormalizedGeneratedImageStep;
};

const matureDictionary: Record<string, boolean> = {
  [NsfwLevel.R]: true,
  [NsfwLevel.X]: true,
  [NsfwLevel.XXX]: true,
};

export function GeneratedImage({
  image,
  request,
  step,
  isLightbox,
}: {
  image: NormalizedGeneratedImage;
  request: Omit<NormalizedGeneratedImageResponse, 'steps'>;
  step: NormalizedGeneratedImageStep;
  isLightbox?: boolean;
}) {
  const features = useFeatureFlags();
  const [ref, inView] = useInViewDynamic({ id: image.id });
  const [loaded, setLoaded] = useState(false);
  const selected = orchestratorImageSelect.useIsSelected({
    workflowId: request.id,
    stepName: step.name,
    imageId: image.id,
  });
  const isSelecting = orchestratorImageSelect.useIsSelecting();

  const [nsfwLevelError, setNsfwLevelError] = useState(false);

  const { updateImages } = useUpdateImageStepMetadata();

  const { running, helpers } = useTourContext();

  const toggleSelect = (checked?: boolean) =>
    orchestratorImageSelect.toggle(
      { workflowId: request.id, stepName: step.name, imageId: image.id },
      checked
    );

  const handleImageClick = () => {
    if (!image || !available || isLightbox || nsfwLevelError) return;

    if (isSelecting) {
      handleToggleSelect();
    } else {
      dialogStore.trigger({
        id: 'generated-image',
        component: GeneratedImageLightbox,
        props: { image, request },
      });
    }
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

  function handleLoad() {
    setLoaded(true);
  }

  function handleError() {
    if (image.url.includes('nsfwLevel')) {
      setNsfwLevelError(true);
    }
  }

  function handleDataTransfer(e: DragEvent<HTMLVideoElement> | DragEvent<HTMLImageElement>) {
    const url = e.currentTarget.currentSrc;
    const meta = getStepMeta(step);
    if (meta) mediaDropzoneData.setData(url, meta);
    e.dataTransfer.setData('text/uri-list', url);
  }

  function handleDragVideo(e: DragEvent<HTMLVideoElement>) {
    handleDataTransfer(e);
  }

  function handleDragImage(e: DragEvent<HTMLImageElement>) {
    handleDataTransfer(e);
  }

  function handleToggleSelect(value = !selected) {
    toggleSelect(value);
    if (running && value) helpers?.next();
  }

  const blockedReason = getImageBlockedReason(image.blockedReason);
  const isBlocked = !!nsfwLevelError || !!blockedReason;
  const aspectRatio = isBlocked ? 1 : image.aspect;

  return (
    <TwCard
      ref={ref}
      className={clsx('max-h-full max-w-full items-center justify-center', classes.imageWrapper)}
      style={{ aspectRatio }}
    >
      {(isLightbox || inView) && (
        <>
          {nsfwLevelError ? (
            <BlockedBlock
              title="Blocked for Adult Content"
              message="Private generation is limited to PG, PG-13 only."
            />
          ) : blockedReason ? (
            <BlockedBlock title={`Blocked ${capitalize(image.type)}`} message={blockedReason} />
          ) : features.isGreen && matureDictionary[image.nsfwLevel ?? ''] ? (
            <BlockedBlock
              title={'Blocked'}
              message={'This image received a mature rating and is unavailable on this site'}
            />
          ) : (
            <EdgeMedia2
              src={image.url}
              type={image.type}
              alt=""
              className={clsx('max-h-full min-h-0 w-auto max-w-full', {
                ['cursor-pointer']: !isLightbox,
                // ['pointer-events-none']: running,
              })}
              onClick={handleImageClick}
              onMouseDown={(e) => {
                if (e.button === 1) return handleAuxClick(image.url);
              }}
              wrapperProps={{
                onClick: handleImageClick,
                onMouseDown: (e) => {
                  if (e.button === 1) return handleAuxClick(image.url);
                },
              }}
              muted={!isLightbox}
              controls={isLightbox}
              disableWebm
              disablePoster
              onLoad={handleLoad}
              onError={handleError}
              imageProps={{
                onDragStart: handleDragImage,
              }}
              videoProps={{
                onLoadedData: handleLoad,
                onError: handleError,
                onDragStart: handleDragVideo,
                draggable: true,
                autoPlay: true,
              }}
            />
          )}
          <div className="pointer-events-none absolute size-full rounded-md shadow-[inset_0_0_2px_1px_rgba(255,255,255,0.2)]" />

          {!isLightbox && !isBlocked && (
            <label className="absolute left-3 top-3" data-tour="gen:select">
              <Checkbox
                className={classes.checkbox}
                checked={selected}
                onChange={(e) => handleToggleSelect(e.target.checked)}
              />
            </label>
          )}
          <Menu zIndex={400} withinPortal>
            <Menu.Target>
              <div className="absolute right-3 top-3">
                <LegacyActionIcon variant="transparent">
                  <IconDotsVertical
                    size={26}
                    color="#fff"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                  />
                </LegacyActionIcon>
              </div>
            </Menu.Target>
            <Menu.Dropdown>
              <GeneratedImageWorkflowMenuItems
                step={step}
                image={image}
                workflowId={request.id}
                isBlocked={isBlocked}
              />
            </Menu.Dropdown>
          </Menu>

          {!isBlocked && (
            <div
              className={clsx(
                classes.actionsWrapper,
                isLightbox && image.type === 'video' ? 'bottom-2 left-12' : 'bottom-1 left-1',
                'absolute flex flex-wrap items-center gap-1 p-1'
              )}
            >
              <LegacyActionIcon
                size="md"
                className={state.favorite ? classes.favoriteButton : undefined}
                variant={state.favorite ? 'light' : 'subtle'}
                color={state.favorite ? 'red' : 'gray'}
                onClick={() => handleToggleFavorite(!state.favorite)}
              >
                <IconHeart size={16} />
              </LegacyActionIcon>

              <Menu
                zIndex={400}
                trigger="hover"
                openDelay={100}
                closeDelay={100}
                transitionProps={{
                  transition: 'fade',
                  duration: 150,
                }}
                withinPortal
                position="top"
              >
                <Menu.Target>
                  <LegacyActionIcon size="md">
                    <IconWand size={16} />
                  </LegacyActionIcon>
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

              <LegacyActionIcon
                size="md"
                variant={state.feedback === 'liked' ? 'light' : 'subtle'}
                color={state.feedback === 'liked' ? 'green' : 'gray'}
                onClick={() => handleToggleFeedback('liked')}
              >
                <IconThumbUp size={16} />
              </LegacyActionIcon>

              <LegacyActionIcon
                size="md"
                variant={state.feedback === 'disliked' ? 'light' : 'subtle'}
                color={state.feedback === 'disliked' ? 'red' : 'gray'}
                onClick={() => handleToggleFeedback('disliked')}
              >
                <IconThumbDown size={16} />
              </LegacyActionIcon>
            </div>
          )}
          {!isLightbox && (
            <div className="absolute bottom-2 right-2">
              <ImageMetaPopover
                meta={step.params as any}
                zIndex={imageGenerationDrawerZIndex + 1}
                hideSoftware
              >
                <LegacyActionIcon variant="transparent" size="md">
                  <IconInfoCircle
                    color="white"
                    filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                    opacity={0.8}
                    strokeWidth={2.5}
                    size={26}
                  />
                </LegacyActionIcon>
              </ImageMetaPopover>
            </div>
          )}
        </>
      )}
    </TwCard>
  );
}

function BlockedBlock({
  title,
  message,
}: {
  title: string;
  message: string | (() => JSX.Element);
}) {
  return (
    <Stack gap="xs" className="p-2">
      <Text c="red" fw="bold" align="center" size="sm">
        {title}
      </Text>
      {typeof message === 'string' ? (
        <Text align="center" size="sm">
          {message}
        </Text>
      ) : (
        message()
      )}
    </Stack>
  );
}

export function GeneratedImageLightbox({
  image,
  request,
}: {
  image: NormalizedGeneratedImage;
  request: Omit<NormalizedGeneratedImageResponse, 'steps'>;
}) {
  const dialog = useDialogContext();
  const { steps } = useGetTextToImageRequestsImages();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

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
    <Modal
      {...dialog}
      closeButtonProps={{
        'aria-label': 'Close lightbox',
      }}
      fullScreen
    >
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
                  {image.url && index === slide && (
                    <GeneratedImage
                      image={image} // TODO - fix this
                      request={request}
                      step={image.step}
                      isLightbox
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
            style: {
              backgroundColor: colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
            },
          }}
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
  isBlocked,
}: {
  image: NormalizedGeneratedImage;
  step: NormalizedGeneratedImageStep;
  workflowId: string;
  workflowsOnly?: boolean;
  isBlocked?: boolean;
}) {
  const { updateImages } = useUpdateImageStepMetadata();
  const { data: workflowDefinitions = [] } = trpc.generation.getWorkflowDefinitions.useQuery();

  const { data: engines } = useGenerationEngines();

  const { copied, copy } = useClipboard();

  const isVideo = step.$type === 'videoGen';
  const isImageGen = step.resources.some((r) => getModelVersionUsesImageGen(r.id));
  const isOpenAI = !isVideo && step.params.engine === 'openai';
  const isFluxKontext = getIsFluxContextFromEngine(step.params.engine);
  const isQwen = !isVideo && getIsQwen(step.params.baseModel);
  const isFlux = !isVideo && getIsFlux(step.params.baseModel);
  const isHiDream = !isVideo && getIsHiDream(step.params.baseModel);
  const isSD3 = !isVideo && getIsSD3(step.params.baseModel);
  const canImg2Img = !isQwen && !isFlux && !isSD3 && !isVideo && !isImageGen && !isHiDream;
  const canImg2ImgNoWorkflow = isOpenAI || isFluxKontext;
  const img2imgWorkflows = !isVideo
    ? workflowDefinitions.filter(
        (x) => x.type === 'img2img' && (!canImg2Img ? x.selectable === false : true)
      )
    : [];

  const img2vidConfigs = !isVideo
    ? engines.filter((x) => !x.disabled && x.processes.includes('img2vid'))
    : [];

  const notSelectableMap: Partial<Record<WorkflowDefinitionKey, VoidFunction>> = {
    'img2img-upscale': handleUpscale,
    'img2img-background-removal': handleRemoveBackground,
    'img2img-upscale-enhancement-realism': handleUpscaleEnhance,
  };

  const canRemix =
    (!!step.params.workflow && !(step.params.workflow in notSelectableMap)) ||
    !!(step.params as any).engine;

  async function handleRemix(seed?: number) {
    handleCloseImageLightbox();
    generationStore.setData({
      resources: step.resources as any,
      params: { ...(step.params as any), seed: seed ?? null },
      remixOfId: step.metadata?.remixOfId,
      type: image.type,
      workflow: step.params.workflow,
      engine: (step.params as any).engine,
    });
  }

  async function handleGenerate(
    { ...rest }: Partial<TextToImageParams> = {},
    {
      type,
      workflow: workflow,
      engine,
    }: { type: MediaType; workflow?: string; engine?: string } = {
      type: image.type,
      workflow: step.params.workflow,
    }
  ) {
    handleCloseImageLightbox();
    generationStore.setData({
      resources: step.resources as any,
      params: {
        ...(step.params as any),
        ...rest,
        sourceImage: await getSourceImageFromUrl({ url: image.url }),
      },
      remixOfId: step.metadata?.remixOfId,
      type,
      workflow: workflow ?? step.params.workflow,
      engine: engine ?? (step.params as any).engine,
    });
  }

  async function handleImg2Vid() {
    let engine = useGenerationFormStore.getState().engine;

    const config = videoGenerationConfig2[engine as OrchestratorEngine2];
    if (!config?.processes.includes('img2vid')) {
      engine = Object.entries(videoGenerationConfig2).find(([key, value]) =>
        value.processes.includes('img2vid')
      )?.[0];
    }

    const { baseModel, ...params } = step.params as any;

    const sourceImage = await getSourceImageFromUrl({ url: image.url });
    generationStore.setData({
      resources: [],
      params: {
        prompt: params.prompt,
        negativePrompt: params.negativePrompt,
        sourceImage: sourceImage,
        images: [sourceImage],
        process: 'img2vid',
      },
      type: 'video',
      engine,
      runType: 'patch',
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
        metadata: step.metadata,
      },
    });
  }

  async function handleUpscaleEnhance() {
    dialogStore.trigger({
      component: UpscaleEnhancementModal,
      props: {
        workflow: 'img2img-upscale-enhancement-realism',
        sourceImage: await getSourceImageFromUrl({ url: image.url, upscale: true }),
        metadata: step.metadata,
      },
    });
  }

  async function handleEnhanceVideo() {
    dialogStore.trigger({
      component: EnhanceVideoModal,
      props: {
        sourceUrl: image.url,
        params: step.params,
      },
    });
  }

  async function handleImg2ImgNoWorkflow() {
    handleGenerate({ sourceImage: image.url as any });
  }

  async function handleUpscale() {
    if (step.$type !== 'videoGen') {
      const sourceImage = await getSourceImageFromUrl({ url: image.url, upscale: true });
      dialogStore.trigger({
        component: UpscaleImageModal,
        props: {
          workflow: 'img2img-upscale',
          sourceImage,
          metadata: step.metadata,
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
      zIndex: imageGenerationDrawerZIndex + 2,
      centered: true,
    });
  }

  return (
    <>
      {canRemix && !workflowsOnly && (
        <>
          <Menu.Item
            onClick={() => handleRemix()}
            leftSection={<IconArrowsShuffle size={14} stroke={1.5} />}
          >
            Remix
          </Menu.Item>
          {!isBlocked && image.seed && (
            <Menu.Item
              onClick={() => handleRemix(image.seed)}
              leftSection={<IconPlayerTrackNextFilled size={14} stroke={1.5} />}
            >
              Remix (with seed)
            </Menu.Item>
          )}
        </>
      )}
      {!workflowsOnly && (
        <Menu.Item
          color="red"
          onClick={handleDeleteImage}
          leftSection={<IconTrash size={14} stroke={1.5} />}
        >
          Delete
        </Menu.Item>
      )}
      {!isBlocked && !workflowsOnly && (!!img2vidConfigs.length || !!img2imgWorkflows.length) && (
        <Menu.Divider />
      )}

      {!isBlocked &&
        img2imgWorkflows.map((workflow) => {
          const handleMappedClick = notSelectableMap[workflow.key];
          const handleDefault = () => handleSelectWorkflow(workflow.key);
          const onClick = handleMappedClick ?? handleDefault;
          return (
            <WithMemberMenuItem
              key={workflow.key}
              onClick={onClick}
              memberOnly={workflow.memberOnly}
            >
              {workflow.name}
            </WithMemberMenuItem>
          );
        })}
      {!isBlocked && canImg2ImgNoWorkflow && (
        <WithMemberMenuItem onClick={handleImg2ImgNoWorkflow}>Image To Image</WithMemberMenuItem>
      )}
      {!isBlocked && !!img2imgWorkflows.length && !!img2vidConfigs.length && <Menu.Divider />}
      {!isBlocked && !!img2vidConfigs.length && (
        <>
          <Menu.Item onClick={handleImg2Vid}>Image To Video</Menu.Item>
        </>
      )}
      {/* {!isBlocked && image.type === 'video' && (
        <>
          <Menu.Item onClick={handleEnhanceVideo}>Upscale Video</Menu.Item>
        </>
      )} */}
      {!workflowsOnly && (
        <>
          <Menu.Divider />
          <Menu.Label>System</Menu.Label>
          <Menu.Item
            leftSection={
              copied ? (
                <IconCheck size={14} stroke={1.5} />
              ) : (
                <IconInfoHexagon size={14} stroke={1.5} />
              )
            }
            onClick={() => copy(workflowId)}
          >
            Copy Workflow ID
          </Menu.Item>
          {!isBlocked && (
            <Menu.Item
              leftSection={<IconExternalLink size={14} stroke={1.5} />}
              onClick={() => handleAuxClick(image.url)}
            >
              Open in New Tab
            </Menu.Item>
          )}
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
        <SupportButtonPolymorphic component={Menu.Item} icon={IconDiamond} position="right">
          {children}
        </SupportButtonPolymorphic>
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

const imageBlockedReasonMap: Record<string, string | (() => JSX.Element)> = {
  ChildReference: 'An inappropriate child reference was detected.',
  Bestiality: 'Bestiality detected.',
  'Child Sexual - Anime': 'Inappropriate minor content detected.',
  'Child Sexual - Realistic': 'Inappropriate minor content detected.',
  NsfwLevel: 'Mature content restriction.',
  NSFWLevelSourceImageRestricted: () => (
    <div className="flex flex-col gap-1">
      <Text align="center" size="sm">
        Mature content restriction.
      </Text>
      <Text align="center" size="sm">
        If your input image lacks valid metadata, generation is restricted to PG or PG-13 outputs
        only.
      </Text>
      <Text
        align="center"
        size="sm"
        component={NextLink}
        href="https://civitai.com/changelog?id=11"
      >
        More info.
      </Text>
    </div>
  ),
};

function getImageBlockedReason(reason?: string | null) {
  if (!reason || reason === 'none') return;
  return imageBlockedReasonMap[reason] ?? reason;
}

// {
//   "ChildReference": "An inappropriate child reference was detected.",
//   "Bestiality": "Detected bestiality in the image.",
//   "Child Sexual - Anime": "An inappropriate child reference was detected.",
//   "Child Sexual - Realistic": "An inappropriate child reference was detected.",
//   "NsfwLevel": "Mature content restriction"
// }
