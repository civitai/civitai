import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useRouter } from 'next/router';
import { useHotkeys } from '@mantine/hooks';
import { ImageDetailByProps } from '~/components/Image/Detail/ImageDetailByProps';
import { ImageGenerationProcess, MediaType } from '@prisma/client';
import { SimpleUser } from '~/server/selectors/user.selector';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { Modal } from '@mantine/core';
import { NsfwLevel } from '~/server/common/enums';
import {
  BadgeCosmetic,
  ContentDecorationCosmetic,
  WithClaimKey,
} from '~/server/selectors/cosmetic.selector';
import { removeEmpty } from '~/utils/object-helpers';

type ImageGuardConnect = {
  entityType:
    | 'model'
    | 'modelVersion'
    | 'review'
    | 'user'
    | 'post'
    | 'collectionItem'
    | 'collection'
    | 'bounty'
    | 'bountyEntry'
    | 'club'
    | 'article';
  entityId: string | number;
};

export interface ImageProps {
  id: number;
  url: string;
  name: string | null;
  meta: ImageMetaProps | null;
  hash: string | null;
  generationProcess: ImageGenerationProcess | null;
  width: number | null;
  height: number | null;
  createdAt: Date | null;
  type: MediaType;
  imageNsfw?: boolean;
  nsfwLevel: NsfwLevel;
  postId?: number | null;
  needsReview?: string | null;
  userId?: number;
  user?: SimpleUser;
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
  tags?: Array<{ id: number }> | number[];
}

type ImageViewerState = {
  imageId: number | null;
  images: ImageProps[];
  setImages: (images: ImageProps[]) => void;
  nextImageId: number | null;
  prevImageId: number | null;
  onClose: () => void;
  onSetImage: (imageId: number) => void;
  setEntityId: (entityId: number | null) => void;
  setEntityType: (entityType: ImageGuardConnect['entityType']) => void;
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
export const ImageViewer = ({ children }: { children: React.ReactNode }) => {
  const router = useRouter();

  const [activeImageId, setActiveImageId] = useState<number | null>(null);
  const [images, setImages] = useState<ImageProps[]>([]);
  const [entityId, setEntityId] = useState<number | null>(null);
  // Always default to post
  const [entityType, setEntityType] = useState<ImageGuardConnect['entityType'] | null>(null);

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
    if (!activeImageId) return;

    const query = removeEmpty({ ...router.query, imageId: undefined });
    router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
  };

  useHotkeys([['Escape', onClose]]);

  useEffect(() => {
    if (router) {
      const res = imageViewerQueryParams.safeParse(router.query);
      if (!res.success || !res.data?.imageId) {
        setActiveImageId(null);
      } else {
        setActiveImageId(res.data.imageId ?? null);
      }
    }
  }, [router.query]);

  const activeImageRecord = images.find((i) => i.id === activeImageId);

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
        setEntityType,
        setEntityId,
      }}
    >
      {activeImageId && (
        <Modal
          opened={!!activeImageId}
          onClose={() => setActiveImageId(null)}
          withCloseButton={false}
          fullScreen
          padding={0}
        >
          <ImageDetailByProps
            imageId={activeImageId}
            onClose={onClose}
            nextImageId={nextImageId}
            prevImageId={prevImageId}
            onSetImage={onSetImage}
            image={activeImageRecord}
            // Attempts to have a few fallbacks to go to. Nothing major.
            connectId={entityId || activeImageRecord?.postId || activeImageId}
            connectType={entityType || 'post'}
          />
        </Modal>
      )}
      {children}
    </ImageViewerCtx.Provider>
  );
};
