import { createContext, useContext, useMemo, useRef } from 'react';
import { StickerPlacementBatchProvider } from '~/components/Sticker/StickerPlacementBatchProvider';
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
  /**
   * Drop the sticker count/reveal chip from the reaction row.
   *
   * For hosts that draw cards narrower than the feed does: the chip shares that
   * row, and at a 280px card it squeezes the reaction counts until they clip.
   * A host that sets this owns putting a reveal control somewhere else.
   */
  hideStickerBadge?: boolean;
  /**
   * Draw placed stickers whatever the viewer's site-wide reveal preference says.
   *
   * For a host whose whole subject is the stickers — the sticker book. The
   * preference is a feed default ("a creator's work is the thing on the page");
   * it is not a statement about a page you opened to look at stickers. Deliberately
   * does NOT write to the store, so it overrides for this page and leaves the
   * viewer's own setting alone everywhere else.
   */
  revealStickers?: boolean;
  collectionId?: number;
  judgeInfo?: JudgeInfo;
  judgingCategories?: JudgingCategory[] | null;
};

export type ImagesContextState = {
  getImages: () => ImageGetInfinite | undefined;
  hideReactionCount?: boolean;
  hideReactions?: boolean;
  hideStickerBadge?: boolean;
  revealStickers?: boolean;
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
  hideStickerBadge,
  revealStickers,
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
      hideStickerBadge,
      revealStickers,
      collectionId,
      judgeInfo,
      judgingCategories,
      getImages: () => imagesRef.current,
    }),
    [
      hideReactionCount,
      hideReactions,
      hideStickerBadge,
      revealStickers,
      collectionId,
      judgeInfo,
      judgingCategories,
    ]
  );

  // Not from `imagesRef`: the ref exists to keep `getImages` stable across
  // renders, and reading it here would leave the batch fetching whatever the
  // first render happened to see.
  const imageIds = useMemo(() => (images ?? []).map((image) => image.id), [images]);

  return (
    <ImagesContext.Provider value={state}>
      <StickerPlacementBatchProvider imageIds={imageIds}>{children}</StickerPlacementBatchProvider>
    </ImagesContext.Provider>
  );
}
