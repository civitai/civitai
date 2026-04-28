import type { AudioBlob, ImageBlob, VideoBlob } from '~/shared/orchestrator/workflow-data';

import { GeneratedAudioOutput } from './GeneratedAudioOutput';
import { GeneratedImageOutput } from './GeneratedImageOutput';
import { GeneratedOutputWrapper } from './GeneratedOutputWrapper';
import { GeneratedVideoOutput } from './GeneratedVideoOutput';

export function GeneratedOutput({
  image,
  isLightbox,
  isActiveSlide,
}: {
  image: ImageBlob | VideoBlob | AudioBlob;
  isLightbox?: boolean;
  isActiveSlide?: boolean;
}) {
  const step = image.step;

  return (
    <GeneratedOutputWrapper image={image} isLightbox={isLightbox} isActiveSlide={isActiveSlide}>
      {({ onClick }) => {
        // Discriminate on `image.type` (the blob container class), which maps 1:1 to the
        // child component's accepted prop type. The only divergence is video-typed audio
        // (aceStepAudio with a cover image bundles audio+cover into a webm VideoBlob),
        // which is routed back to GeneratedAudioOutput via the mediaType check.
        switch (image.type) {
          case 'audio':
            return <GeneratedAudioOutput image={image} isLightbox={isLightbox} onClick={onClick} />;
          case 'video':
            return image.mediaType === 'audio' ? (
              <GeneratedAudioOutput image={image} isLightbox={isLightbox} onClick={onClick} />
            ) : (
              <GeneratedVideoOutput
                image={image}
                step={step}
                isLightbox={isLightbox}
                isActiveSlide={isActiveSlide}
                onClick={onClick}
              />
            );
          case 'image':
            return (
              <GeneratedImageOutput
                image={image}
                step={step}
                isLightbox={isLightbox}
                onClick={onClick}
              />
            );
        }
      }}
    </GeneratedOutputWrapper>
  );
}
