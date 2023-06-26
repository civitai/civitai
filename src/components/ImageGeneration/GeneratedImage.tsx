import { AspectRatio, Loader, Center, Card } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { useState } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { Generation } from '~/server/services/generation/generation.types';

export function GeneratedImage({
  width,
  height,
  image,
}: {
  width: number;
  height: number;
  image?: Generation.Image;
}) {
  const [loading, setLoading] = useState(true);

  const handleImageClick = () => {
    if (!image) return;
    openContextModal({
      modal: 'generatedImageLightbox',
      size: width + 40,
      innerProps: {
        width,
        image,
      },
    });
  };

  return (
    <AspectRatio ratio={width / height}>
      <Card p={0} sx={{ position: 'relative' }} withBorder>
        {loading && (
          <Center sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <Loader />
          </Center>
        )}
        {image && (
          <EdgeImage
            src={image.url}
            width={width}
            onLoad={() => setLoading(false)}
            onError={() => setLoading(false)}
            onClick={handleImageClick}
            style={{ cursor: 'pointer' }}
          />
        )}
      </Card>
    </AspectRatio>
  );
}
