import { Checkbox, Menu, Text } from '@mantine/core';
import { IconAlertTriangle, IconDotsVertical, IconInfoCircle } from '@tabler/icons-react';
import clsx from 'clsx';
import type { ReactNode } from 'react';

import { dialogStore } from '~/components/Dialog/dialogStore';
import { useGeneratedItemStore } from '~/components/Generation/stores/generated-item.store';
import { orchestratorImageSelect } from '~/components/ImageGeneration/utils/generationImage.select';
import { useUpdateImageStepMetadata } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useInViewDynamic } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { TextToImageQualityFeedbackModal } from '~/components/Modals/GenerationQualityFeedbackModal';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { GeneratedItemWorkflowMenu } from '~/components/generation_v2/GeneratedItemWorkflowMenu';
import type { AudioBlob, ImageBlob, VideoBlob } from '~/shared/orchestrator/workflow-data';

import { GeneratedOutputActions } from './GeneratedOutputActions';
import classes from './GeneratedImage.module.css';

export function GeneratedOutputWrapper({
  image,
  isLightbox,
  isActiveSlide,
  children,
}: {
  image: ImageBlob | VideoBlob | AudioBlob;
  isLightbox?: boolean;
  isActiveSlide?: boolean;
  children: (props: { onClick: () => void }) => ReactNode;
}) {
  const step = image.step;
  const request = image.workflow;
  const [ref, inView] = useInViewDynamic({ id: image.id });
  const selected = orchestratorImageSelect.useIsSelected(image);
  const isSelecting = orchestratorImageSelect.useIsSelecting();

  const { updateImages } = useUpdateImageStepMetadata();
  const { running, helpers } = useTourContext();
  const available = image.available;

  const toggleSelect = (checked?: boolean) => orchestratorImageSelect.toggle(image, checked);

  const handleClick = () => {
    if (!image || !available || isLightbox) return;

    if (isSelecting) {
      handleToggleSelect();
    } else {
      // Lazy import to avoid circular dependency
      import('./GeneratedOutputLightbox').then(({ default: GeneratedOutputLightbox }) => {
        dialogStore.trigger({
          id: 'generated-image',
          component: GeneratedOutputLightbox,
          props: { imageId: image.id, workflowId: request.id },
        });
      });
    }
  };

  // Read via `outputMeta` so legacy `metadata.images` data is merged with the
  // current `metadata.output` data. Direct reads off `step.metadata.output` would
  // miss legacy workflows whose per-output state still lives under `images`.
  const outputMeta = image.outputMeta;
  const [state, setState] = useGeneratedItemStore({
    id: `${request.id}_${step.name}_${image.id}`,
    favorite: outputMeta?.favorite === true,
    feedback: outputMeta?.feedback,
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
          comments: outputMeta?.comments,
          stepName: step.name,
        },
      });
    }

    updateImages(
      [
        {
          workflowId: request.id,
          stepName: step.name,
          images: { [image.id]: { feedback: newFeedback } },
        },
      ],
      onError
    );
  }

  function handleToggleFavorite(newValue: boolean) {
    const previousState = state;
    setState({ favorite: newValue });

    const onError = () => setState(previousState);

    updateImages(
      [
        {
          workflowId: request.id,
          stepName: step.name,
          images: { [image.id]: { favorite: newValue } },
        },
      ],
      onError
    );
  }

  function handleToggleSelect(value = !selected) {
    toggleSelect(value);
    if (running && value) helpers?.next();
  }

  const aspectRatio = image.aspect;

  // Step terminated but the blob never materialized — show an error card in the slot.
  if (!image.available && image.errored) {
    return (
      <TwCard
        className="flex flex-col items-center justify-center gap-2 border border-red-5 p-3"
        style={{ aspectRatio }}
      >
        <IconAlertTriangle size={28} className="text-red-5" />
        <Text c="red" fw="bold" align="center" size="sm">
          Generation failed
        </Text>
        <Text c="dimmed" align="center" size="xs">
          {`We couldn't complete your request at the moment, try again later`}
        </Text>
      </TwCard>
    );
  }

  // Still processing (no terminal state yet) — render nothing so the placeholder card above takes the slot.
  if (!image.available) return <></>;

  return (
    <TwCard
      ref={ref}
      className={clsx(
        'max-w-full border',
        isLightbox ? 'max-h-[calc(100vh-32px)]' : 'w-full self-start',
        selected && 'ring-2 ring-blue-5/60'
      )}
      style={
        isLightbox
          ? {
              width: `min(${image.width}px, 100%, calc((100vh - 76px) * ${image.aspect}))`,
            }
          : undefined
      }
    >
      {!isLightbox && !inView && <div style={{ aspectRatio }} />}
      {(isLightbox || inView) && (
        <>
          <div
            className={clsx(
              'relative flex items-center justify-center',
              isLightbox ? 'max-h-[calc(100vh-76px)]' : 'max-h-full'
            )}
            style={{ aspectRatio }}
          >
            {children({ onClick: handleClick })}

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
                  <GeneratedItemWorkflowMenu image={image} isLightbox={isLightbox} />
                </Menu.Dropdown>
              </Menu>
            )}
          </div>

          {!image.blockedReason && (
            <GeneratedOutputActions
              output={image}
              state={state}
              isLightbox={isLightbox}
              onToggleFavorite={handleToggleFavorite}
              onToggleFeedback={handleToggleFeedback}
              infoSlot={
                <ImageMetaPopover
                  meta={step.params as any}
                  zIndex={imageGenerationDrawerZIndex + 1}
                  hideSoftware
                >
                  <LegacyActionIcon size="md" variant="subtle" color="gray">
                    <IconInfoCircle size={16} />
                  </LegacyActionIcon>
                </ImageMetaPopover>
              }
            />
          )}
        </>
      )}
    </TwCard>
  );
}
