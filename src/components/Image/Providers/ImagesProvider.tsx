import { createContext, useContext } from 'react';
import { ImageGetInfinite } from '~/types/router';

const ImagesContext = createContext<{ images?: ImageGetInfinite } | null>(null);
export const useImagesContext = () => {
  const context = useContext(ImagesContext);
  if (!context) throw new Error('missing ImagesContext');
  return context;
};

export function ImagesProvider({
  children,
  images,
}: {
  children: React.ReactNode;
  images?: ImageGetInfinite;
}) {
  return <ImagesContext.Provider value={{ images }}>{children}</ImagesContext.Provider>;
}
