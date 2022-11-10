import { Carousel, Embla } from '@mantine/carousel';
import { Box, CloseButton } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { ContextModalProps } from '@mantine/modals';
import { useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageModel } from '~/server/validators/image/selectors';

type Props = {
  initialSlide?: number;
  images?: ImageModel[];
};

export default function LightboxImageCarousel({
  context,
  id,
  innerProps,
}: ContextModalProps<Props>) {
  const { initialSlide, images = [] } = innerProps;
  const [embla, setEmbla] = useState<Embla | null>(null);

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  return (
    <>
      <CloseButton
        style={{ position: 'absolute', top: 15, right: 15, zIndex: 100 }}
        size="lg"
        variant="default"
        onClick={() => context.closeModal(id)}
      />
      <Box style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex' }}>
        <Carousel
          height="100%"
          sx={{ flex: 1 }}
          initialSlide={initialSlide}
          withIndicators
          loop
          getEmblaApi={setEmbla}
          styles={{
            control: {
              '&[data-inactive]': {
                opacity: 0,
                cursor: 'default',
              },
            },
          }}
        >
          {images.map((image) => (
            <Carousel.Slide key={image.url}>
              <picture
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <EdgeImage
                  src={image.url}
                  alt={image.name ?? undefined}
                  style={{ maxHeight: '100%', maxWidth: '100%' }}
                  width={image.width ?? 1200}
                />
              </picture>
            </Carousel.Slide>
          ))}
        </Carousel>
      </Box>
    </>
  );
}
