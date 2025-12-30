import type { MenuItemProps } from '@mantine/core';
import {
  Checkbox,
  Menu,
  Modal,
  Text,
  Stack,
  Tooltip,
  useComputedColorScheme,
  useMantineTheme,
  Badge,
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
import { dialogStore } from '~/components/Dialog/dialogStore';
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
  getIsPonyV7,
  getIsQwen,
  getIsSD3,
  getIsZImageTurbo,
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
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { getModelVersionUsesImageGen } from '~/shared/orchestrator/ImageGen/imageGen.config';
import { getIsFluxContextFromEngine } from '~/shared/orchestrator/ImageGen/flux1-kontext.config';
import { SupportButtonPolymorphic } from '~/components/SupportButton/SupportButton';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { getSourceImageFromUrl } from '~/utils/image-utils';
import { UpscaleVideoModal } from '~/components/Orchestrator/components/UpscaleVideoModal';
import { VideoInterpolationModal } from '~/components/Orchestrator/components/VideoInterpolationModal';

export type GeneratedImageProps = {
  image: NormalizedGeneratedImage;
  request: Omit<NormalizedGeneratedImageResponse, 'steps'>;
  step: Omit<NormalizedGeneratedImageStep, 'images'>;
};

export function GeneratedImage({
  image,
  request,
  step,
  isLightbox,
}: {
  image: NormalizedGeneratedImage;
  request: Omit<NormalizedGeneratedImageResponse, 'steps'>;
  step: Omit<NormalizedGeneratedImageStep, 'images'>;
  isLightbox?: boolean;
}) {
  const [ref, inView] = useInViewDynamic({ id: image.id });
  const selected = orchestratorImageSelect.useIsSelected({
    workflowId: request.id,
    stepName: step.name,
    imageId: image.id,
  });
  const isSelecting = orchestratorImageSelect.useIsSelecting();

  const { updateImages } = useUpdateImageStepMetadata();

  const { running, helpers } = useTourContext();
  const available = image.status === 'succeeded';

  const toggleSelect = (checked?: boolean) =>
    orchestratorImageSelect.toggle(
      { workflowId: request.id, stepName: step.name, imageId: image.id },
      checked
    );

  const handleImageClick = () => {
    if (!image || !available || isLightbox) return;

    if (isSelecting) {
      handleToggleSelect();
    } else {
      dialogStore.trigger({
        id: 'generated-image',
        component: GeneratedImageLightbox,
        props: { image },
      });
    }
  };

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

  if (image.status !== 'succeeded') return <></>;

  function handleDataTransfer(e: DragEvent<HTMLVideoElement> | DragEvent<HTMLImageElement>) {
    // Always use full quality URL for drag and drop, not the preview
    const url = image.url;
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

  return (
    <TwCard
      ref={ref}
      className={clsx('max-h-full max-w-full items-center justify-center', classes.imageWrapper)}
      style={{ aspectRatio: image.aspect }}
    >
      {(isLightbox || inView) && (
        <>
          {
            <EdgeMedia2
              // Use previewUrl for rendering in queue (smaller/faster), but full url for lightbox
              src={isLightbox ? image.url : (image.previewUrl ?? image.url)}
              type={image.type}
              alt=""
              className={clsx('max-h-full min-h-0 w-auto max-w-full', {
                ['cursor-pointer']: !isLightbox,
                // ['pointer-events-none']: running,
              })}
              onClick={handleImageClick}
              onMouseDown={(e) => {
                // Always use full url when opening in new tab
                if (e.button === 1) return handleAuxClick(image.url);
              }}
              wrapperProps={{
                onClick: handleImageClick,
                onMouseDown: (e) => {
                  // Always use full url when opening in new tab
                  if (e.button === 1) return handleAuxClick(image.url);
                },
              }}
              muted={!isLightbox}
              controls={isLightbox}
              disableWebm
              disablePoster
              imageProps={{
                onDragStart: handleDragImage,
              }}
              videoProps={{
                onDragStart: handleDragVideo,
                draggable: true,
                autoPlay: true,
              }}
            />
          }
          <div className="pointer-events-none absolute size-full rounded-md shadow-[inset_0_0_2px_1px_rgba(255,255,255,0.2)]" />

          {!isLightbox && !image.blockedReason && (
            <label className="absolute left-3 top-3" data-tour="gen:select">
              <Checkbox
                className={classes.checkbox}
                checked={selected}
                onChange={(e) => handleToggleSelect(e.target.checked)}
              />
            </label>
          )}
          {!image.blockedReason && (
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
                />
              </Menu.Dropdown>
            </Menu>
          )}

          {!image.blockedReason && (
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

export function GeneratedImageLightbox({ image }: { image: NormalizedGeneratedImage }) {
  const dialog = useDialogContext();
  const { requests, steps } = useGetTextToImageRequestsImages();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const [embla, setEmbla] = useState<EmblaCarouselType | null>(null);
  // useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  const images = steps.flatMap(({ images, ...step }) =>
    images
      .filter((x) => x.status === 'succeeded' && !x.blockedReason)
      .map((image) => ({ ...image, params: { ...step.params, seed: image.seed }, step }))
  );
  const workflows = requests?.map(({ steps, ...workflow }) => workflow) ?? [];

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
              {images.map((image, index) => {
                const request = workflows.find((x) => x.id === image.workflowId);
                if (!request) return null;
                return (
                  <Embla.Slide
                    key={`${image.workflowId}_${image.id}`}
                    index={index}
                    className="flex flex-[0_0_100%] items-center justify-center"
                  >
                    {image.url && index === slide && (
                      <GeneratedImage
                        image={image}
                        request={request}
                        step={image.step}
                        isLightbox
                      />
                    )}
                  </Embla.Slide>
                );
              })}
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
  step: Omit<NormalizedGeneratedImageStep, 'images'>;
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
  const baseModel = 'baseModel' in step.params ? step.params.baseModel : undefined;
  const isOpenAI = !isVideo && step.params.engine === 'openai';
  const isNanoBanana = baseModel === 'NanoBanana';
  const isSeedream = baseModel === 'Seedream';
  const isFluxKontext = getIsFluxContextFromEngine(step.params.engine);
  const isQwen = !isVideo && getIsQwen(baseModel);
  const isFlux = !isVideo && getIsFlux(baseModel);
  const isHiDream = !isVideo && getIsHiDream(baseModel);
  const isSD3 = !isVideo && getIsSD3(baseModel);
  const isPonyV7 = step.resources.some((x) => getIsPonyV7(x.id));
  const isZImageTurbo = !isVideo && getIsZImageTurbo(baseModel);
  const canImg2Img =
    !isQwen &&
    !isFlux &&
    !isSD3 &&
    !isVideo &&
    !isImageGen &&
    !isHiDream &&
    !isPonyV7 &&
    !isZImageTurbo;

  const canImg2ImgNoWorkflow = isOpenAI || isFluxKontext || isNanoBanana || isSeedream;
  const img2imgWorkflows =
    !isVideo && !isBlocked
      ? workflowDefinitions.filter(
          (x) => x.type === 'img2img' && (!canImg2Img ? x.selectable === false : true)
        )
      : [];

  const img2vidConfigs = !isVideo
    ? engines.filter((x) => !x.disabled && x.processes.includes('img2vid'))
    : [];

  const notSelectableMap: Partial<Record<WorkflowDefinitionKey, VoidFunction>> = {
    'img2img-upscale': handleUpscaleImage,
    'img2img-background-removal': handleRemoveBackground,
    'img2img-upscale-enhancement-realism': handleUpscaleEnhance,
  };

  const canRemix =
    (!!step.params.workflow && !(step.params.workflow in notSelectableMap)) ||
    !!(step.params as any).engine;

  async function handleRemix(seed?: number | null) {
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

  async function handleUpscaleImage() {
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

  function handleUpscaleVideo() {
    dialogStore.trigger({
      component: UpscaleVideoModal,
      props: {
        videoUrl: image.url,
        metadata: step.metadata,
      },
    });
  }

  function handleVideoInterpolation() {
    dialogStore.trigger({
      component: VideoInterpolationModal,
      props: {
        videoUrl: image.url,
        metadata: step.metadata,
      },
    });
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
      {!isBlocked && step.$type === 'videoGen' && (
        <>
          <Menu.Divider />
          <Menu.Item onClick={handleUpscaleVideo} className="flex items-center gap-1">
            Upscale{' '}
            <Badge color="yellow" className="ml-1">
              Preview
            </Badge>
          </Menu.Item>
          <Menu.Item onClick={handleVideoInterpolation} className="flex items-center gap-1">
            Interpolation{' '}
            <Badge color="yellow" className="ml-1">
              Preview
            </Badge>
          </Menu.Item>
        </>
      )}
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
