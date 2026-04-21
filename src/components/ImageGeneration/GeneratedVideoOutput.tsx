import type { DragEvent } from 'react';

import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { StepData, VideoBlob } from '~/shared/orchestrator/workflow-data';
import { mediaDropzoneData } from '~/store/post-image-transmitter.store';

import { getStepMeta } from './GenerationForm/generation.utils';

export function GeneratedVideoOutput({
  image,
  step,
  isLightbox,
  isActiveSlide,
  onClick,
}: {
  image: VideoBlob;
  step: StepData;
  isLightbox?: boolean;
  isActiveSlide?: boolean;
  onClick?: () => void;
}) {
  function handleDragVideo(e: DragEvent<HTMLVideoElement>) {
    const url = image.url;
    const meta = getStepMeta(step);
    if (meta) mediaDropzoneData.setData(url, meta);
    e.dataTransfer.setData('text/uri-list', url);
  }

  return (
    <EdgeMedia2
      src={image.url}
      type="video"
      alt=""
      className={`max-h-full min-h-0 w-auto max-w-full${!isLightbox ? ' cursor-pointer' : ''}`}
      onClick={onClick}
      onMouseDown={(e) => {
        if (e.button === 1) window.open(image.url, '_blank');
      }}
      wrapperProps={{
        onClick,
        onMouseDown: (e) => {
          if (e.button === 1) window.open(image.url, '_blank');
        },
      }}
      muted={!isLightbox || !isActiveSlide}
      controls={isLightbox && isActiveSlide}
      disableWebm
      disablePoster
      videoProps={{
        onDragStart: handleDragVideo,
        draggable: true,
        autoPlay: true,
      }}
    />
  );
}
