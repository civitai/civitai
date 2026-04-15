import type { DragEvent, MouseEvent } from 'react';

import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import type { ImageBlob, StepData } from '~/shared/orchestrator/workflow-data';
import { mediaDropzoneData } from '~/store/post-image-transmitter.store';

import { getStepMeta } from './GenerationForm/generation.utils';

export function GeneratedImageOutput({
  image,
  step,
  isLightbox,
  onClick,
}: {
  image: ImageBlob;
  step: StepData;
  isLightbox?: boolean;
  onClick?: () => void;
}) {
  function handleDragImage(e: DragEvent<HTMLImageElement>) {
    const url = image.url;
    const meta = getStepMeta(step);
    if (meta) mediaDropzoneData.setData(url, meta);
    e.dataTransfer.setData('text/uri-list', url);
  }

  function handleContextMenu(e: MouseEvent<HTMLImageElement>) {
    const element = e.currentTarget;
    const previewUrl = image.previewUrl ?? image.url;

    if (image.previewUrl && 'src' in element && !isLightbox) {
      element.src = image.url;

      const restore = () => {
        element.src = previewUrl;
        document.removeEventListener('click', restore);
        document.removeEventListener('keydown', restore);
      };

      setTimeout(() => {
        document.addEventListener('click', restore, { once: true });
        document.addEventListener('keydown', restore, { once: true });
      }, 0);
    }
  }

  return (
    <EdgeMedia2
      src={isLightbox ? image.url : image.previewUrl ?? image.url}
      type="image"
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
      imageProps={{
        onDragStart: handleDragImage,
        onContextMenu: handleContextMenu,
        ...(isLightbox && {
          style: {
            width: 'auto',
            maxHeight: 'calc(100vh - 32px)',
            maxWidth: 'calc(100vw - 32px)',
          },
        }),
      }}
    />
  );
}
