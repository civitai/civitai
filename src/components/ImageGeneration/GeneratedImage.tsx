import { AspectRatio, Loader, Center, Card, ThemeIcon } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Generation } from '~/server/services/generation/generation.types';

type GeneratedImageStatus = 'loading' | 'loaded' | 'error';

export function GeneratedImage({
  image,
  request,
}: {
  image?: Generation.Image;
  request: Generation.Request;
}) {
  const [status, setStatus] = useState<GeneratedImageStatus>('loading');
  const [qs, setQs] = useState<string>('');

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

  const retry = () => setQs(`?${Date.now()}`);

  const handleLoad = () => {
    setStatus('loaded');
  };

  const handleError = () => retry();

  return (
    <AspectRatio ratio={request.params.width / request.params.height}>
      <Card p={0} sx={{ position: 'relative' }} withBorder>
        {status !== 'loaded' && (
          <Center sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}>
            {status === 'loading' && <Loader />}
            {status === 'error' && (
              <ThemeIcon size="md" color="red" variant="light">
                <IconX size={20} />
              </ThemeIcon>
            )}
          </Center>
        )}
        {status !== 'error' && image && (
          <EdgeImage
            src={image.url + qs}
            width={request.params.width}
            onLoad={handleLoad}
            onError={handleError}
            onClick={handleImageClick}
            style={{ cursor: 'pointer', zIndex: 2 }}
          />
        )}
      </Card>
    </AspectRatio>
  );
}
