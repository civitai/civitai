import { Carousel, Embla } from '@mantine/carousel';
import { Box, CloseButton, Text, Code, Stack, Paper } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { ContextModalProps } from '@mantine/modals';
import { useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageMetaProps } from '~/server/validators/image/schemas';
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
          {images.map((image) => {
            const meta = image.meta as ImageMetaProps | null;
            return (
              <Carousel.Slide key={image.url}>
                <div
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
                </div>
                {meta && (
                  <div
                    style={{
                      position: 'absolute',
                      left: 0,
                      right: 0,
                      bottom: '50px',
                      display: 'flex',
                      justifyContent: 'center',
                      alignItems: 'center',
                      zIndex: 100,
                    }}
                  >
                    <Paper
                      sx={(theme) => ({
                        background: theme.fn.rgba(theme.black, 0.5),
                      })}
                      p="md"
                      radius="md"
                    >
                      <Stack spacing={0}>
                        <Text>
                          Prompt: <Code>{meta.prompt}</Code>
                        </Text>
                        <Text>
                          Negative Prompt: <Code>{meta.negativePrompt}</Code>
                        </Text>
                        <Text>
                          CFG Scale: <Code>{meta.cfgScale}</Code>
                        </Text>
                      </Stack>
                    </Paper>
                  </div>
                )}
              </Carousel.Slide>
            );
          })}
        </Carousel>
      </Box>
    </>
  );
}
