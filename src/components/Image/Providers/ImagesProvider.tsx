import { createContext, useContext, useMemo, useRef } from 'react';
import type { ImageGetInfinite } from '~/types/router';
import type { ProfileImage } from '~/server/selectors/image.selector';
import type { JudgingCategory } from '~/server/games/daily-challenge/daily-challenge-scoring';

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
  judgingCategories?: JudgingCategory[] | null;
};

export type ImagesContextState = {
  getImages: () => ImageGetInfinite | undefined;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  collectionId?: number;
  judgeInfo?: JudgeInfo;
  judgingCategories?: JudgingCategory[] | null;
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
  judgingCategories,
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
      judgingCategories,
      getImages: () => imagesRef.current,
    }),
    [hideReactionCount, hideReactions, collectionId, judgeInfo, judgingCategories]
  );

  return <ImagesContext.Provider value={state}>{children}</ImagesContext.Provider>;
}
