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
        switch (image.type) {
          case 'audio':
            return <GeneratedAudioOutput image={image} />;
          case 'video':
            return (
              <GeneratedVideoOutput
                image={image}
                step={step}
                isLightbox={isLightbox}
                isActiveSlide={isActiveSlide}
                onClick={onClick}
              />
            );
          default:
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
