import { AspectRatio, Loader, Center, Card, Text, Stack, Group } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { IconHourglass } from '@tabler/icons-react';
import { Generation } from '~/server/services/generation/generation.types';

// type GeneratedImageStatus = 'loading' | 'loaded' | 'error';

export function GeneratedImage({
  image,
  request,
}: {
  image: Generation.Image;
  request: Generation.Request;
}) {
  const handleImageClick = () => {
    if (!image) return;
    openContextModal({
      modal: 'generatedImageLightbox',
      zIndex: 400,
      transitionDuration: 200,
      fullScreen: true,
      closeButtonLabel: 'Close lightbox',
      innerProps: {
        image,
        request,
      },
    });
  };

  return (
    <AspectRatio ratio={request.params.width / request.params.height}>
      <Card p={0} sx={{ position: 'relative' }} withBorder>
        {!image.available ? (
          <Center
            sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}
            p="xs"
          >
            {!image.status && (
              <Stack align="center">
                <IconHourglass />
                <Text color="dimmed" size="xs">
                  Queued
                </Text>
              </Stack>
            )}
            {image.status === 'Started' && (
              <Stack align="center">
                <Loader size={24} />
                <Text color="dimmed" size="xs" align="center">
                  Generating
                </Text>
              </Stack>
            )}
            {image.status === 'Error' && (
              <Text color="dimmed" size="xs" align="center">
                Could not load image
              </Text>
            )}
          </Center>
        ) : (
          // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
          <img
            alt=""
            src={image.url}
            onClick={handleImageClick}
            style={{ cursor: 'pointer', zIndex: 2, width: '100%' }}
          />
        )}
      </Card>
    </AspectRatio>
  );
}
