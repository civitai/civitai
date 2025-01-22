import { createContext, useContext } from 'react';
import { ImageGetInfinite } from '~/types/router';

export type ImagesContextState = {
  images?: ImageGetInfinite;
  hideReactionCount?: boolean;
  collectionId?: number;
};

const ImagesContext = createContext<ImagesContextState | null>(null);
export const useImagesContext = () => {
  const context = useContext(ImagesContext);
  if (!context) return {};
  return context;
};

export function ImagesProvider({
  children,
  ...state
}: {
  children: React.ReactNode;
} & ImagesContextState) {
  return <ImagesContext.Provider value={state}>{children}</ImagesContext.Provider>;
}
