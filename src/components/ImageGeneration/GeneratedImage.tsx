import { AspectRatio, Loader, Center, Card, Text } from '@mantine/core';
import { openContextModal } from '@mantine/modals';
import { useEffect, useRef, useState } from 'react';
import { Generation } from '~/server/services/generation/generation.types';

type GeneratedImageStatus = 'loading' | 'loaded' | 'error';
const imageCache = new Map<string, string>();
export function clearImageCache() {
  for (const [key, url] of imageCache.entries()) {
    URL.revokeObjectURL(url);
    imageCache.delete(key);
  }
}

export function GeneratedImage({
  image,
  request,
}: {
  image?: Generation.Image;
  request: Generation.Request;
}) {
  const [status, setStatus] = useState<GeneratedImageStatus>('loading');
  const ref = useRef<HTMLImageElement>(null);
  const initializedRef = useRef(false);

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

  const handleLoad = () => setStatus('loaded');

  const fetchImage = async (url: string) => {
    // if (imageCache.has(url)) {
    //   if (!ref.current) return;
    //   ref.current.src = imageCache.get(url) as string;
    //   return;
    // }

    try {
      const response = await fetch(url);

      switch (response.status) {
        case 404: {
          setStatus('error');
          break;
        }
        case 408: {
          fetchImage(`${url}?${Date.now()}`);
          break;
        }
        case 200: {
          if (!ref.current) return;
          // todo - only run for non-successful requests
          ref.current.src = url;
          // const blob = await response.blob();
          // // TODO.generation - Embed metadata into image
          // const objectUrl = URL.createObjectURL(blob);
          // if (!ref.current) return;
          // // imageCache.set(url, objectUrl);
          // ref.current.src = objectUrl;
          // if (request.id === 4512) {
          //   console.log({ blob });
          //   console.log({ imageCache });
          // }
          break;
        }
        default: {
          console.error('unhandled generated image error');
        }
      }
    } catch (e) {
      console.error(e);
      setStatus('error');
    }
  };

  useEffect(() => {
    if (image?.url && !ref.current?.src && !initializedRef.current) {
      initializedRef.current = true;
      fetchImage(image.url);
    }
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
