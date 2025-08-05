import { createContext, useContext } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';

type ImageCtx = {
  isOwner: boolean;
  isModerator: boolean;
};

const ImageContext = createContext<ImageCtx>({ isOwner: false, isModerator: false });
export const useImageContext = () => useContext(ImageContext);

type ImageProviderProps = {
  id: number;
  userId?: number;
  user?: { id?: number };
};

export function ImageProvider({
  children,
  ...image
}: ImageProviderProps & { children: React.ReactNode }) {
  const currentUser = useCurrentUser();

  return (
    <ImageContext.Provider
      value={{
        isOwner: currentUser?.id === image.userId || currentUser?.id === image.user?.id,
        isModerator: currentUser?.isModerator ?? false,
      }}
    >
      {children}
    </ImageContext.Provider>
  );
}
