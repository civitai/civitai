import { AspectRatio, Loader, Center, Card, ThemeIcon, Text } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
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
  const ref = useRef<HTMLImageElement>(null);
  const urlRef = useRef<string>();
  const initializedRef = useRef(false);
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

  const fetchImage = async (url: string) => {
    const response = await fetch(url);

    switch (response.status) {
      case 404: {
        setStatus('error');
        break;
      }
      case 408: {
        fetchImage(url);
        break;
      }
      case 200: {
        const blob = await response.blob();
        urlRef.current = URL.createObjectURL(blob);
        if (!ref.current) return;
        ref.current.src = urlRef.current;
        break;
      }
      default: {
        console.error('unhandled generated image error');
      }
    }
  };

  useEffect(() => {
    if (image?.url && !ref.current?.src && !initializedRef.current) {
      initializedRef.current = true;
      fetchImage(image.url);
    }
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  return (
    <AspectRatio ratio={request.params.width / request.params.height}>
      <Card p={0} sx={{ position: 'relative' }} withBorder>
        {status !== 'loaded' && (
          <Center
            sx={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 1 }}
            p="xs"
          >
            {status === 'loading' && <Loader />}
            {status === 'error' && (
              <Text color="dimmed" size="xs" align="center">
                Could not load image
              </Text>
            )}
          </Center>
        )}
        {status !== 'error' && image && (
          // eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element
          <img
            ref={ref}
            alt=""
            onLoad={handleLoad}
            onClick={handleImageClick}
            style={{ cursor: 'pointer', zIndex: 2, width: '100%' }}
          />
        )}
      </Card>
    </AspectRatio>
  );
}
