import { Checkbox, Menu } from '@mantine/core';
import {
  IconDotsVertical,
  IconHeart,
  IconInfoCircle,
  IconThumbDown,
  IconThumbUp,
  IconWand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { DragEvent, MouseEvent } from 'react';
import { useState } from 'react';

import dynamic from 'next/dynamic';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useGeneratedItemStore } from '~/components/Generation/stores/generated-item.store';
import { orchestratorImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import { useUpdateImageStepMetadata } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { TextToImageQualityFeedbackModal } from '~/components/Modals/GenerationQualityFeedbackModal';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { GeneratedItemWorkflowMenu } from '~/components/generation_v2/GeneratedItemWorkflowMenu';
import type {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageResponse,
  NormalizedGeneratedImageStep,
} from '~/server/services/orchestrator';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { mediaDropzoneData } from '~/store/post-image-transmitter.store';

import { getStepMeta } from './GenerationForm/generation.utils';
import classes from './GeneratedImage.module.css';
import GeneratedImageLightbox from '~/components/ImageGeneration/GeneratedImageLightbox';

// const GeneratedImageLightbox = dynamic(
//   () => import('~/components/ImageGeneration/GeneratedImageLightbox'),
//   { ssr: false }
// );

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
        props: { imageId: image.id, workflowId: request.id },
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

  function handleContextMenu(e: MouseEvent<HTMLImageElement | HTMLVideoElement>) {
    // Swap to full quality URL before context menu shows
    // so "Save Image As" saves the full quality version
    const element = e.currentTarget;
    const previewUrl = image.previewUrl ?? image.url;

    if (image.previewUrl && 'src' in element && !isLightbox) {
      element.src = image.url;

      // Restore preview after context menu closes
      const restore = () => {
        element.src = previewUrl;
        document.removeEventListener('click', restore);
        document.removeEventListener('keydown', restore);
      };

      // Delay listener attachment to allow context menu to process
      setTimeout(() => {
        document.addEventListener('click', restore, { once: true });
        document.addEventListener('keydown', restore, { once: true });
      }, 0);
    }
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
              src={isLightbox ? image.url : image.previewUrl ?? image.url}
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
                onContextMenu: handleContextMenu,
              }}
              videoProps={{
                onDragStart: handleDragVideo,
                onContextMenu: handleContextMenu,
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
              <Menu.Dropdown className={classes.scrollableDropdown}>
                <GeneratedItemWorkflowMenu
                  step={step}
                  image={image}
                  workflowId={request.id}
                  isLightbox={isLightbox}
                />
              </Menu.Dropdown>
            </Menu>
          )}

          {!image.blockedReason && (
            <GeneratedImageActions
              image={image}
              step={step}
              workflowId={request.id}
              state={state}
              isLightbox={isLightbox}
              onToggleFavorite={handleToggleFavorite}
              onToggleFeedback={handleToggleFeedback}
            />
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

function GeneratedImageActions({
  image,
  step,
  workflowId,
  state,
  isLightbox,
  onToggleFavorite,
  onToggleFeedback,
}: {
  image: NormalizedGeneratedImage;
  step: Omit<NormalizedGeneratedImageStep, 'images'>;
  workflowId: string;
  state: { favorite?: boolean; feedback?: string };
  isLightbox?: boolean;
  onToggleFavorite: (value: boolean) => void;
  onToggleFeedback: (feedback: 'liked' | 'disliked') => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className={clsx(
        classes.actionsWrapper,
        menuOpen && classes.actionsVisible,
        isLightbox && image.type === 'video' ? 'bottom-2 left-12' : 'bottom-1 left-1',
        'absolute flex flex-wrap items-center gap-1 p-1'
      )}
    >
      <LegacyActionIcon
        size="md"
        className={state.favorite ? classes.favoriteButton : undefined}
        variant={state.favorite ? 'light' : 'subtle'}
        color={state.favorite ? 'red' : 'gray'}
        onClick={() => onToggleFavorite(!state.favorite)}
      >
        <IconHeart size={16} />
      </LegacyActionIcon>

      <Menu
        zIndex={400}
        trigger="click-hover"
        openDelay={100}
        closeDelay={100}
        transitionProps={{
          transition: 'fade',
          duration: 150,
        }}
        withinPortal
        position="top"
        onChange={setMenuOpen}
        withArrow
      >
        <Menu.Target>
          <LegacyActionIcon size="md">
            <IconWand size={16} />
          </LegacyActionIcon>
        </Menu.Target>
        <Menu.Dropdown className={clsx(classes.improveMenu, classes.scrollableDropdown)}>
          <GeneratedItemWorkflowMenu
            step={step}
            image={image}
            workflowId={workflowId}
            workflowsOnly
            isLightbox={isLightbox}
          />
        </Menu.Dropdown>
      </Menu>

      <LegacyActionIcon
        size="md"
        variant={state.feedback === 'liked' ? 'light' : 'subtle'}
        color={state.feedback === 'liked' ? 'green' : 'gray'}
        onClick={() => onToggleFeedback('liked')}
      >
        <IconThumbUp size={16} />
      </LegacyActionIcon>

      <LegacyActionIcon
        size="md"
        variant={state.feedback === 'disliked' ? 'light' : 'subtle'}
        color={state.feedback === 'disliked' ? 'red' : 'gray'}
        onClick={() => onToggleFeedback('disliked')}
      >
        <IconThumbDown size={16} />
      </LegacyActionIcon>
    </div>
  );
}

function handleAuxClick(url: string) {
  window.open(url, '_blank');
}
