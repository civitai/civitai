import { createContext, useContext, useMemo, useRef } from 'react';
import type { ImageGetInfinite } from '~/types/router';

type ImagesContextProps = {
  images?: ImageGetInfinite;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  collectionId?: number;
};

export type ImagesContextState = {
  getImages: () => ImageGetInfinite | undefined;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
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
  hideReactions,
  collectionId,
}: {
  children: React.ReactNode;
} & ImagesContextProps) {
  const imagesRef = useRef<ImageGetInfinite | undefined>();
  imagesRef.current = images;
  const state = useMemo(
    () => ({ hideReactionCount, hideReactions, collectionId, getImages: () => imagesRef.current }),
    [hideReactionCount, hideReactions, collectionId]
  );

  return <ImagesContext.Provider value={state}>{children}</ImagesContext.Provider>;
}
