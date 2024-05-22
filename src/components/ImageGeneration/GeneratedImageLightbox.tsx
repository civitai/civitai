import { Carousel, Embla, useAnimationOffsetEffect } from '@mantine/carousel';
import { Modal } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { truncate } from 'lodash-es';
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { constants } from '~/server/common/constants';
import { Generation } from '~/server/services/generation/generation.types';

const TRANSITION_DURATION = 200;

export function GeneratedImageLightbox({
  image,
  request,
}: {
  image: Generation.Image;
  request: Generation.Request;
}) {
  const dialog = useDialogContext();
  const { images: feed } = useGetGenerationRequests();

  const [embla, setEmbla] = useState<Embla | null>(null);
  useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  const filteredFeed = useMemo(() => feed.filter((item) => item.available), [feed]);
  const initialSlide = filteredFeed.findIndex((item) => item.id === image.id);

  return (
    <Modal {...dialog} closeButtonLabel="Close lightbox" fullScreen>
      <Carousel
        align="center"
        slideGap="md"
        slidesToScroll={1}
        controlSize={40}
        initialSlide={initialSlide > -1 ? initialSlide : 0}
        getEmblaApi={setEmbla}
        withKeyboardEvents={false}
        loop
      >
        {filteredFeed.map((item) => (
          <Carousel.Slide
            key={item.id}
            style={{
              height: 'calc(100vh - 84px)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <EdgeMedia
              src={item.url}
              type="image"
              alt={truncate(request.params.prompt, { length: constants.altTruncateLength })}
              width={request.params.width}
              className="max-h-full w-auto max-w-full"
            />
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
          params={request.params}
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
