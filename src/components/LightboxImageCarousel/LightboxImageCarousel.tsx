import { Carousel, Embla } from '@mantine/carousel';
import {
  Box,
  CloseButton,
  Text,
  Code,
  Stack,
  Paper,
  Title,
  Group,
  ActionIcon,
  createStyles,
  Popover,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { ContextModalProps } from '@mantine/modals';
import { IconInfoCircle, IconMinus, IconPlus, IconX } from '@tabler/icons';
import { useEffect, useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageMeta, ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { ImageMetaProps } from '~/server/schema/image.schema';
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
  const [show, setShow] = useState(true);
  const [index, setIndex] = useState(initialSlide ?? 0);

  const { classes, cx } = useStyles();

  const handlePrev = () => {
    setIndex((prev) => {
      const index = prev - 1;
      return index === -1 ? images.length - 1 : index;
    });
  };

  const handleNext = () => {
    setIndex((prev) => {
      const index = prev + 1;
      return index === images.length ? 0 : index;
    });
  };

  useHotkeys([
    ['ArrowLeft', () => embla?.scrollPrev()],
    ['ArrowRight', () => embla?.scrollNext()],
  ]);

  useEffect(() => console.log({ show }), [show]);

  return (
    <>
      <CloseButton
        style={{ position: 'absolute', top: 15, right: 15, zIndex: 100 }}
        size="lg"
        variant="default"
        onClick={() => context.closeModal(id)}
      />
      <Box
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          overflow: 'hidden',
        }}
      >
        <Carousel
          height="100%"
          sx={{ flex: 1 }}
          initialSlide={initialSlide}
          withIndicators
          loop
          onPreviousSlide={handlePrev}
          onNextSlide={handleNext}
          getEmblaApi={setEmbla}
          styles={{
            control: {
              zIndex: 100,
              '&[data-inactive]': {
                opacity: 0,
                cursor: 'default',
              },
            },
          }}
        >
          {images.map((image) => (
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
              {/* {image.meta && (
                <Box
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: '350px',
                    maxWidth: '100%',
                  }}
                  sx={(theme) => ({
                    background: theme.fn.rgba(theme.black, 0.65),
                  })}
                  p="md"
                >
                  <Stack>
                    <Title order={4}>Metadata</Title>
                    <ImageMeta meta={image.meta as ImageMetaProps} />
                  </Stack>
                </Box>
              )} */}
            </Carousel.Slide>
          ))}
        </Carousel>
        {/* {images[index]?.meta && (
          <ImageMetaPopover meta={images[index].meta as ImageMetaProps}>
            <ActionIcon
              style={{ position: 'absolute', top: 15, left: 15, zIndex: 100 }}
              size="lg"
              variant="default"
            >
              <IconInfoCircle />
            </ActionIcon>
          </ImageMetaPopover>
        )} */}
        {images[index]?.meta && (
          <Paper className={cx(classes.meta, { [classes.metaActive]: show })} p="md" withBorder>
            <Stack>
              <Title order={4}>Metadata</Title>

              <ActionIcon
                onClick={() => setShow((v) => !v)}
                className={cx(classes.metaButton, { [classes.metaActive]: show })}
                size="xl"
                variant="light"
              >
                {show ? <IconMinus /> : <IconInfoCircle />}
              </ActionIcon>
              <ImageMeta meta={images[index].meta as ImageMetaProps} />
            </Stack>
          </Paper>
        )}
      </Box>
    </>
  );
}

const useStyles = createStyles((theme, _params, getRef) => ({
  metaActive: {
    ref: getRef('meta-active'),
  },
  meta: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: '350px',
    maxWidth: '100%',
    background: theme.fn.rgba(theme.black, 0.65),
    transform: 'translateY(100%)',
    transition: '.3s ease-in-out transform',
    zIndex: 110,

    [`&.${getRef('meta-active')}`]: {
      transform: 'translateY(0)',
    },
  },
  metaButton: {
    position: 'absolute',
    right: 0,
    top: 0,
    // background: theme.fn.rgba(theme.black, 0.65),
    transform: 'translateY(-100%)',
    transition: '.3s ease-in-out transform',

    '&:active': {
      transform: 'translateY(-100%)',
    },

    [`&.${getRef('meta-active')}`]: {
      transform: 'translateY(0)',
    },
  },
}));
