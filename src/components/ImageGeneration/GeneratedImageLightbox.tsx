import { Carousel, Embla, useAnimationOffsetEffect } from '@mantine/carousel';
import { Box, Center } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { ContextModalProps } from '@mantine/modals';
import { useState } from 'react';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { GenerationDetails } from '~/components/ImageGeneration/GenerationDetails';
import { useGetGenerationRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
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

  const initialSlide = feed.findIndex((item) => item.id === image.id);
  const [currentSlide, setCurrentSlide] = useState<number>(initialSlide);

  const [embla, setEmbla] = useState<Embla | null>(null);
  useAnimationOffsetEffect(embla, TRANSITION_DURATION);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  return (
    <Box sx={{ position: 'relative' }}>
      <Carousel
        align="center"
        slideGap="md"
        slidesToScroll={1}
        controlSize={40}
        onSlideChange={setCurrentSlide}
        initialSlide={initialSlide > -1 ? initialSlide : 0}
        getEmblaApi={setEmbla}
        withKeyboardEvents={false}
        loop
      >
        {feed.map((item) => (
          <Carousel.Slide key={item.id} sx={{ height: 'calc(100vh - 84px)' }}>
            <Center h="100%">
              <EdgeImage src={item.url} width={request.params.width} />
            </Center>
          </Carousel.Slide>
        ))}
      </Carousel>
      <Box sx={{ position: 'fixed', bottom: 0, right: 0, width: '100%', maxWidth: 450 }}>
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
      </Box>
    </Box>
  );
}
