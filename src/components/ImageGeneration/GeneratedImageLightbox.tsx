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
  NormalizedTextToImageImage,
  NormalizedTextToImageResponse,
} from '~/server/services/orchestrator';

const TRANSITION_DURATION = 200;

export function GeneratedImageLightbox({
  image,
  request,
}: {
  image: NormalizedTextToImageImage;
  request: NormalizedTextToImageResponse;
}) {
  const dialog = useDialogContext();
  const initialSlideRef = useRef<number>();
  const { steps } = useGetTextToImageRequestsImages();

  const [embla, setEmbla] = useState<Embla | null>(null);
  useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  if (!initialSlideRef.current)
    initialSlideRef.current = steps
      .flatMap((x) => x.images)
      .filter((item) => item.status === 'succeeded')
      .findIndex((item) => item.id === image.id);

  return (
    <Modal {...dialog} closeButtonLabel="Close lightbox" fullScreen>
      <Carousel
        align="center"
        slideGap="md"
        slidesToScroll={1}
        controlSize={40}
        initialSlide={initialSlideRef.current > -1 ? initialSlideRef.current : 0}
        getEmblaApi={setEmbla}
        withKeyboardEvents={false}
        loop
      >
        {steps.map((step) =>
          step.images
            .filter((x) => x.status === 'succeeded')
            .map((item) => (
              <React.Fragment key={`${item.workflowId}_${item.id}`}>
                <Carousel.Slide
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
                      alt={truncate(step.params.prompt, { length: constants.altTruncateLength })}
                      width={step.params.width}
                      className="max-h-full w-auto max-w-full"
                    />
                  )}
                </Carousel.Slide>
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
                    params={step.params}
                    labelWidth={150}
                    paperProps={{ radius: 0 }}
                    controlProps={{
                      sx: (theme) => ({
                        backgroundColor:
                          theme.colorScheme === 'dark'
                            ? theme.colors.dark[5]
                            : theme.colors.gray[2],
                      }),
                    }}
                    upsideDown
                  />
                </div>
              </React.Fragment>
            ))
        )}
      </Carousel>
    </Modal>
  );
}
