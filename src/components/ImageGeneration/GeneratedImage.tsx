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
    if (!image || !image.available) return;
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
      <Card
        p={0}
        onClick={handleImageClick}
        sx={(theme) => ({
          position: 'relative',
          boxShadow:
            '0 2px 3px rgba(0, 0, 0, .5), 0px 20px 25px -5px rgba(0, 0, 0, 0.2), 0px 10px 10px -5px rgba(0, 0, 0, 0.04)',
          cursor: 'pointer',
          [`&::after`]: {
            content: '""',
            display: 'block',
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 2,
            boxShadow: 'inset 0px 0px 2px 1px rgba(255,255,255,0.2)',
            borderRadius: theme.radius.sm,
          },
        })}
      >
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
          <img alt="" src={image.url} style={{ zIndex: 2, width: '100%' }} />
        )}
      </Card>
    </AspectRatio>
  );
}
