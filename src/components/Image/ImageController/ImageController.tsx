import { createStyles } from '@mantine/core';
import { useState, useRef, useEffect, useCallback } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { loadImage, getImageData, blurHashImage } from '~/utils/blurhash';
import { getMetadata } from '~/utils/image-metadata';
import { trpc } from '~/utils/trpc';

type ImageProps = {
  id?: number;
  url: string;
  hash?: string;
  name?: string;
  nsfw?: boolean;
  meta?: unknown;
  count?: {
    tags?: number;
    resources?: number;
  };
};

export type ImageControllerProps = {
  image?: ImageProps;
  file?: File;
};

/** Only to be used in create/edit views */
export function ImageController({ image: initialImage, file }: ImageControllerProps) {
  const urlRef = useRef<string>();
  const { classes, cx } = useStyles();

  const [image, setImage] = useState(initialImage);

  const { uploadToCF } = useCFImageUpload();
  const { mutate, isLoading } = trpc.image.create.useMutation();

  const handleFile = useCallback(async (file: File) => {
    const name = file.name;
    const src = URL.createObjectURL(file);
    const meta = await getMetadata(file);
    const img = await loadImage(src);
    const hashResult = blurHashImage(img);

    return {
      name,
      src,
      meta,
      ...hashResult,
    };
  }, []);

  useEffect(() => {
    const url = urlRef.current;
    return () => {
      console.log({ url });
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  return image ? (
    // TODO.posts link to image edit drawer
    <div className={classes.root}>
      <EdgeImage src={image.url} alt={image.name ?? undefined} />
      {/* TODO.posts - badges to display info about image details */}
    </div>
  ) : null;
}

const useStyles = createStyles((theme) => ({
  root: {
    position: 'relative',
  },
}));
