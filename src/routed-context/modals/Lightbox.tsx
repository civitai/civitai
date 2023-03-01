import { Carousel, Embla } from '@mantine/carousel';
import {
  ModalProps,
  Modal,
  useMantineTheme,
  createStyles,
  MantineProvider,
  ActionIcon,
  Box,
  CloseButton,
  Paper,
  Stack,
  Center,
  Loader,
  AspectRatio,
} from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { IconMinus, IconInfoCircle } from '@tabler/icons';
import { useState, useRef } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { ImageGuard, ImageGuardConnect } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImageMeta } from '~/components/ImageMeta/ImageMeta';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ImageModel } from '~/server/selectors/image.selector';

type LightboxProps = {
  nsfw?: boolean;
  initialSlide?: number;
  images?: Omit<ImageModel, 'tags'>[];
  connect: ImageGuardConnect;
};

export function Lightbox({
  initialSlide,
  images = [],
  opened,
  onClose,
  nsfw,
  connect,
  ...props
}: Omit<ModalProps, 'children' | 'id'> & LightboxProps) {
  const theme = useMantineTheme();
  const [show, setShow] = useState(false);
  const [index, setIndex] = useState(initialSlide ?? 0);

  const emblaRef = useRef<Embla | null>(null);

  const { classes, cx } = useStyles();

  useHotkeys([
    ['ArrowLeft', () => emblaRef.current?.scrollPrev()],
    ['ArrowRight', () => emblaRef.current?.scrollNext()],
  ]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      withCloseButton={false}
      styles={{ modal: { background: theme.colors.dark[7] } }}
      {...props}
    >
      <MantineProvider theme={{ colorScheme: 'dark' }}>
        <CloseButton
          style={{ position: 'absolute', top: 15, right: 15, zIndex: 100 }}
          size="lg"
          variant="default"
          onClick={onClose}
        />
        <Box
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            // display: 'flex',
            overflow: 'hidden',
          }}
        >
          {!images.length ? (
            <Center sx={{ height: '100%', width: '100%' }}>
              <Loader />
            </Center>
          ) : (
            <Box sx={{ width: '100%', height: '100%', display: 'flex' }}>
              <Carousel
                height="100%"
                sx={{ flex: 1 }}
                initialSlide={initialSlide}
                withIndicators={images.length > 1}
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
                <ImageGuard
                  images={images}
                  connect={connect}
                  nsfw={nsfw}
                  render={(image) => {
                    const width = image?.width ?? 1200;
                    const height = image?.height ?? 1200;

                    return (
                      <Carousel.Slide key={image.url}>
                        <Center
                          sx={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            right: 0,
                            bottom: 0,
                          }}
                        >
                          <div style={{ position: 'relative' }}>
                            <ImageGuard.ToggleConnect />
                            <ImageGuard.Unsafe>
                              <AspectRatio
                                ratio={width / height}
                                sx={{
                                  maxHeight: '100vh',
                                  maxWidth: '100vw',
                                  height,
                                  width,
                                }}
                              >
                                <MediaHash {...image} />
                              </AspectRatio>
                            </ImageGuard.Unsafe>
                            <ImageGuard.Safe>
                              <EdgeImage
                                src={image.url}
                                name={image.name ?? image.id.toString()}
                                alt={image.name ?? undefined}
                                style={{ maxHeight: '100vh', maxWidth: '100vw' }}
                                width={width}
                              />
                            </ImageGuard.Safe>
                          </div>
                        </Center>
                      </Carousel.Slide>
                    );
                  }}
                />
              </Carousel>
              {images[index]?.meta && (
                <Paper
                  className={cx(classes.meta, { [classes.metaActive]: show })}
                  p="md"
                  withBorder
                >
                  <Stack>
                    <ActionIcon
                      onClick={() => setShow((v) => !v)}
                      className={cx(classes.metaButton, { [classes.metaActive]: show })}
                      size="xl"
                      variant="light"
                    >
                      {show ? <IconMinus /> : <IconInfoCircle />}
                    </ActionIcon>
                    <ImageMeta
                      meta={images[index].meta as ImageMetaProps}
                      generationProcess={images[index].generationProcess ?? 'txt2img'}
                    />
                  </Stack>
                </Paper>
              )}
            </Box>
          )}
        </Box>
      </MantineProvider>
    </Modal>
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
