import { createContext, useContext, useMemo, useRef } from 'react';
import type { ImageGetInfinite } from '~/types/router';
import type { ProfileImage } from '~/server/selectors/image.selector';

export type JudgeInfo = {
  userId: number;
  username: string;
  profilePicture?: ProfileImage | null;
};

type ImagesContextProps = {
  images?: ImageGetInfinite;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  collectionId?: number;
  judgeInfo?: JudgeInfo;
};

export type ImagesContextState = {
  getImages: () => ImageGetInfinite | undefined;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  collectionId?: number;
  judgeInfo?: JudgeInfo;
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
  judgeInfo,
}: {
  children: React.ReactNode;
} & ImagesContextProps) {
  const imagesRef = useRef<ImageGetInfinite | undefined>();
  imagesRef.current = images;
  const state = useMemo(
    () => ({
      hideReactionCount,
      hideReactions,
      collectionId,
      judgeInfo,
      getImages: () => imagesRef.current,
    }),
    [hideReactionCount, hideReactions, collectionId, judgeInfo]
  );

  return <ImagesContext.Provider value={state}>{children}</ImagesContext.Provider>;
}
