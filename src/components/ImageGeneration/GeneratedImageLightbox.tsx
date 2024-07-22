import { Carousel, Embla, useAnimationOffsetEffect } from '@mantine/carousel';
import { Modal } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { truncate } from 'lodash-es';
import React, { useMemo, useRef, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { useGetTextToImageRequestsImages } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { constants } from '~/server/common/constants';
import {
  NormalizedGeneratedImage,
  NormalizedGeneratedImageResponse,
} from '~/server/services/orchestrator';

const TRANSITION_DURATION = 200;

export function GeneratedImageLightbox({
  image,
  request,
}: {
  image: NormalizedGeneratedImage;
  request: NormalizedGeneratedImageResponse;
}) {
  const dialog = useDialogContext();
  const { steps } = useGetTextToImageRequestsImages();

  const [embla, setEmbla] = useState<Embla | null>(null);
  useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  const images = steps.flatMap((step) =>
    step.images
      .filter((x) => x.status === 'succeeded')
      .map((image) => ({ ...image, params: { ...step.params, seed: image.seed } }))
  );

  const [slide, setSlide] = useState(() => {
    const initialSlide = images.findIndex((item) => item.id === image.id);
    return initialSlide > -1 ? initialSlide : 0;
  });

  return (
    <Modal {...dialog} closeButtonLabel="Close lightbox" fullScreen>
      <Carousel
        align="center"
        slideGap="md"
        slidesToScroll={1}
        controlSize={40}
        initialSlide={slide}
        getEmblaApi={setEmbla}
        withKeyboardEvents={false}
        onSlideChange={setSlide}
        loop
      >
        {images.map((item) => (
          <Carousel.Slide
            key={`${item.workflowId}_${item.id}`}
            style={{
              height: 'calc(100vh - 84px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {item.url && (
              <EdgeMedia
                src={item.url}
                type="image"
                alt={truncate(item.params.prompt, { length: constants.altTruncateLength })}
                width={item.params.width}
                className="max-h-full w-auto max-w-full"
              />
            )}
          </Carousel.Slide>
        ))}
      </Carousel>
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
