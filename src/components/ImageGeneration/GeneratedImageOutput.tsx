import clsx from 'clsx';
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
  onLoaded,
  loaded,
}: {
  image: ImageBlob;
  step: StepData;
  isLightbox?: boolean;
  onClick?: () => void;
  onLoaded?: () => void;
  loaded?: boolean;
}) {
  function handleDragImage(e: DragEvent<HTMLImageElement>) {
    const url = image.url;
    const meta = getStepMeta(step);
    if (meta) mediaDropzoneData.setData(url, meta);
    e.dataTransfer.setData('text/uri-list', url);

    // Set only the drag-feedback "ghost" (the translucent preview under the cursor).
    // This does NOT resize the image or the dropped file — the post is fetched full-
    // resolution from `image.url` on drop. We point the ghost at the already-rendered
    // (small, thumbnail-sized) <img> so the browser snapshots that box instead of
    // rasterizing the full-resolution source. Without this, Chrome aborts drag-start
    // when the source is large (hi-res-fix ~1800px is marginally over the limit;
    // upscales up to 4k are far over) — dragstart fires but immediately ends with
    // dropEffect 'none', silently breaking drag-to-post. ~1024px outputs stay under
    // the limit, which is why only hi-res-fix/upscale results were affected.
    // The 2nd/3rd args are the cursor hotspot WITHIN the ghost (centered), not a scale.
    const img = e.currentTarget;
    e.dataTransfer.setDragImage(img, img.clientWidth / 2, img.clientHeight / 2);
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
      className={clsx(
        'max-h-full min-h-0 w-auto max-w-full',
        !isLightbox && 'cursor-pointer',
        isLightbox && 'transition-opacity duration-200',
        isLightbox && !loaded && 'opacity-0'
      )}
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
        onLoad: onLoaded,
        ...(isLightbox && {
          style: {
            width: 'auto',
            height: 'auto',
            maxHeight: 'calc(100vh - 76px)',
            maxWidth: 'calc(100vw - 32px)',
          },
        }),
      }}
    />
  );
}
