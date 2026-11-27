import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { useCallback } from 'react';
import { create } from 'zustand';
import { removeEmpty } from '~/utils/object-helpers';

type ImageProps = {
  tosViolation?: boolean;
  ingestion?: ImageIngestionStatus;
  blockedFor?: string | null;
  needsReview?: string | null;
  nsfwLevel?: number;
};

type ImageStore = {
  [key: number]: ImageProps;
  setImage: (id: number, data: ImageProps) => void;
};

const useStore = create<ImageStore>((set) => ({
  setImage: (id, data) => set((state) => ({ [id]: { ...state[id], ...data } })),
}));

export const imageStore = {
  setImage: useStore.getState().setImage,
};

/**
 * What an owner's ingestion signal writes to the store. A Blocked signal with no reason (the
 * server withholds every reason the owner cannot act on) records `blockedFor: null`, so a
 * reason the page loaded earlier, such as AiNotVerified, stops showing for a different block.
 */
export function storeUpdateFromIngestionSignal({
  ingestion,
  blockedFor,
  nsfwLevel,
}: {
  ingestion: ImageIngestionStatus;
  blockedFor?: string | null;
  nsfwLevel?: number;
}): ImageProps {
  return {
    ingestion,
    blockedFor: blockedFor ?? (ingestion === ImageIngestionStatus.Blocked ? null : undefined),
    ...(nsfwLevel !== undefined && { nsfwLevel }),
  };
}

/** The image with its live store values on top; an explicit `blockedFor: null` clears the loaded reason. */
export function mergeStoredImage<T extends object>(image: T, storeImage: ImageProps) {
  return {
    ...image,
    ...removeEmpty(storeImage),
    ...(storeImage.blockedFor === null && { blockedFor: null }),
  };
}

export const useImageStore = <T extends { id: number } & ImageProps>(image: T) => {
  return useStore(useCallback((state) => mergeStoredImage(image, state[image.id] ?? {}), [image]));
};
