import { Carousel, Embla } from '@mantine/carousel';
import {
  Box,
  CloseButton,
  Stack,
  Paper,
  ActionIcon,
  createStyles,
  MantineProvider,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { ContextModalProps } from '@mantine/modals';
import { IconInfoCircle, IconMinus } from '@tabler/icons';
import { useRef, useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageModel } from '~/server/selectors/image.selector';

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
  const [show, setShow] = useState(false);
  const [index, setIndex] = useState(initialSlide ?? 0);

  const emblaRef = useRef<Embla | null>(null);

  const { classes, cx } = useStyles();

  useHotkeys([
    ['ArrowLeft', () => emblaRef.current?.scrollPrev()],
    ['ArrowRight', () => emblaRef.current?.scrollNext()],
  ]);

  return (
    <MantineProvider theme={{ colorScheme: 'dark' }}>
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
          onSlideChange={(index) => setIndex(index)}
          withKeyboardEvents={false}
          getEmblaApi={(embla) => {
            emblaRef.current = embla;
          }}
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
            </Carousel.Slide>
          ))}
        </Carousel>
        {images[index]?.meta && (
          <Paper className={cx(classes.meta, { [classes.metaActive]: show })} p="md" withBorder>
            <Stack>
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
    </MantineProvider>
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
