import { AspectRatio, Loader, Center, Card, ThemeIcon } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Generation } from '~/server/services/generation/generation.types';

type GeneratedImageStatus = 'loading' | 'loaded' | 'error';

export function GeneratedImage({
  width,
  height,
  image,
}: {
  width: number;
  height: number;
  image?: Generation.Image;
}) {
  const [status, setStatus] = useState<GeneratedImageStatus>('loading');
  const [qs, setQs] = useState<string>('');

  const handleImageClick = () => {
    if (!image) return;
    openContextModal({
      modal: 'generatedImageLightbox',
      size: width + 40,
      zIndex: 400,
      innerProps: {
        width,
        image,
      },
    });
  };

  const retry = () => setQs(`?${Date.now()}`);

  return (
    <AspectRatio ratio={width / height}>
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
            width={width}
            onLoad={() => setStatus('loaded')}
            onError={() => retry()}
            onClick={handleImageClick}
            style={{ cursor: 'pointer', zIndex: 2 }}
          />
        )}
      </Card>
    </AspectRatio>
  );
}
