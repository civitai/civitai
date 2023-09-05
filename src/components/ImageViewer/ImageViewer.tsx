import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useRouter } from 'next/router';
import { useHotkeys } from '@mantine/hooks';
import { ImageDetailByProps } from '~/components/Image/Detail/ImageDetailByProps';
import { NsfwLevel } from '@prisma/client';
import { SimpleUser } from '~/server/selectors/user.selector';

interface ImageProps {
  id: number;
  nsfw: NsfwLevel;
  imageNsfw?: boolean;
  postId?: number | null;
  width?: number | null;
  height?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
  url?: string | null;
  name?: string | null;
}

type ImageViewerState = {
  imageId: number | null;
  images: ImageProps[];
  setImages: (images: { id: number }[]) => void;
  nextImageId: number | null;
  prevImageId: number | null;
  onClose: () => void;
  onSetImage: (imageId: number) => void;
};

const ImageViewerCtx = createContext<ImageViewerState>({} as any);
export const useImageViewerCtx = () => {
  const context = useContext(ImageViewerCtx);
  if (!context) throw new Error('useImageViewerCtx can only be used inside ImageViewerCtx');
  return context;
};

const imageViewerQueryParams = z
  .object({
    imageId: z.coerce.number(),
  })
  .partial();
export const ImageViewer = ({ children }: { children: React.ReactElement }) => {
  const router = useRouter();

  const [activeImageId, setActiveImageId] = useState<number | null>(null);
  const [images, setImages] = useState<ImageProps[]>([]);

  const nextImageId = useMemo(() => {
    if (!activeImageId) return null;

    const index = images.findIndex((image) => image.id === activeImageId);
    if (index === -1) return null;
    return images[index + 1]?.id ?? null;
  }, [images, activeImageId]);

  const prevImageId = useMemo(() => {
    if (!activeImageId) return null;

    const index = images.findIndex((image) => image.id === activeImageId);
    if (index === -1) return null;
    return images[index - 1]?.id ?? null;
  }, [images, activeImageId]);

  const onSetImage = (imageId: number | null) => {
    if (!imageId) {
      return;
    }

    if (activeImageId) {
      router.replace(
        {
          pathname: router.pathname,
          query: {
            ...router.query,
            imageId: imageId ? imageId.toString() : undefined,
          },
        },
        undefined,
        { shallow: true }
      );
    } else {
      router.push(
        {
          pathname: router.pathname,
          query: {
            ...router.query,
            imageId: imageId ? imageId.toString() : undefined,
          },
        },
        undefined,
        { shallow: true }
      );
    }
  };
  const onClose = () => {
    router.replace(
      {
        pathname: router.pathname,
        query: {
          ...router.query,
          imageId: undefined,
        },
      },
      undefined,
      { shallow: true }
    );
  };

  useHotkeys([['Escape', onClose]]);

  useEffect(() => {
    if (router) {
      const res = imageViewerQueryParams.safeParse(router.query);
      console.log(res);
      if (!res.success || !res.data?.imageId) {
        setActiveImageId(null);
      } else {
        setActiveImageId(res.data.imageId ?? null);
      }
    }
  }, [router?.query]);

  useEffect(() => {
    if (router) {
      router.beforePopState((state) => {
        state.options.scroll = false;
        return true;
      });
    }
  }, [router]);

  return (
    <ImageViewerCtx.Provider
      value={{
        imageId: activeImageId,
        nextImageId,
        prevImageId,
        images,
        setImages,
        onSetImage,
        onClose,
      }}
    >
      {activeImageId && (
        <div
          style={{
            position: 'fixed',
            zIndex: 99999,
          }}
        >
          <ImageDetailByProps
            imageId={activeImageId}
            onClose={onClose}
            nextImageId={nextImageId}
            prevImageId={prevImageId}
            onSetImage={onSetImage}
          />
        </div>
      )}
      {children}
    </ImageViewerCtx.Provider>
  );
};
