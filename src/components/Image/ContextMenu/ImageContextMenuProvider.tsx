import type { ImageProps } from '~/components/ImageViewer/ImageViewer';
import { createContext, useContext } from 'react';

type ImageContextMenuCtx = {
  additionalMenuItemsBefore?: (data: ImageProps) => React.ReactNode;
  additionalMenuItemsAfter?: (data: ImageProps) => React.ReactNode;
};

const ImageContextMenuContext = createContext<ImageContextMenuCtx>({});
export const useImageContextMenuContext = () => useContext(ImageContextMenuContext);

export function ImageContextMenuProvider({
  children,
  ...props
}: ImageContextMenuCtx & { children: React.ReactNode }) {
  return (
    <ImageContextMenuContext.Provider value={props}>{children}</ImageContextMenuContext.Provider>
  );
}
