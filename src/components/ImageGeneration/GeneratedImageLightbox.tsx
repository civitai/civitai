import { Carousel, Embla, useAnimationOffsetEffect } from '@mantine/carousel';
import { Center } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { ContextModalProps } from '@mantine/modals';
import { useMemo, useState } from 'react';

import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useAspectRatioFit } from '~/hooks/useAspectRatioFit';
import { Generation } from '~/server/services/generation/generation.types';

const TRANSITION_DURATION = 200;

export default function GeneratedImageLightbox({
  innerProps,
}: ContextModalProps<{
  image: Generation.Image;
  request: Generation.Request;
}>) {
  const { image, request } = innerProps;
  const { images: feed } = useGetGenerationRequests();

  const { setRef, height, width } = useAspectRatioFit({
    width: request.params.width ?? 1200,
    height: request.params.height ?? 1200,
  });

  const [embla, setEmbla] = useState<Embla | null>(null);
  useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  const filteredFeed = useMemo(() => feed.filter((item) => item.available), [feed]);
  const initialSlide = filteredFeed.findIndex((item) => item.id === image.id);

  return (
    <div ref={setRef} style={{ position: 'relative' }}>
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
            <Center h={height} w={width}>
              <EdgeMedia src={item.url} width={request.params.width} />
            </Center>
          </Carousel.Slide>
        ))}
      </Carousel>
      <div style={{ position: 'fixed', bottom: 0, right: 0, width: '100%', maxWidth: 450 }}>
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
    </div>
  );
}
