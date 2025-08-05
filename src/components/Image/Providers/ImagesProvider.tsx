import { createContext, useContext, useMemo, useRef } from 'react';
import type { ImageGetInfinite } from '~/types/router';

type ImagesContextProps = {
  images?: ImageGetInfinite;
  hideReactionCount?: boolean;
  collectionId?: number;
};

export type ImagesContextState = {
  getImages: () => ImageGetInfinite | undefined;
  hideReactionCount?: boolean;
  collectionId?: number;
};

const ImagesContext = createContext<ImagesContextState | null>(null);
export const useImagesContext = () => {
  const context = useContext(ImagesContext);
  if (!context) return { getImages: () => undefined };
  return context;
};

export function ImagesProvider({
  children,
  images,
  hideReactionCount,
  collectionId,
}: {
  children: React.ReactNode;
} & ImagesContextProps) {
  const imagesRef = useRef<ImageGetInfinite | undefined>();
  imagesRef.current = images;
  const state = useMemo(
    () => ({ hideReactionCount, collectionId, getImages: () => imagesRef.current }),
    [hideReactionCount, collectionId]
  );

  return <ImagesContext.Provider value={state}>{children}</ImagesContext.Provider>;
}
