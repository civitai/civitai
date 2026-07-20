import { createContext, useContext } from 'react';
import type { ModelById } from '~/types/router';

type ModelVersionsProps = { id: number; name: string; modelId: number };

/**
 * What entity this gallery is bound to. Discriminated so consumers can narrow
 * once instead of juggling parallel-but-nullable fields.
 *  - `model`   — the regular Model gallery flow (versions, gallery
 *                moderation settings, resource reviews, pinned posts, …)
 *  - `model3d` — Model3D gallery (no versions, no gallery settings, posts
 *                are pre-resolved server-side via Post.model3dId)
 */
export type ImagesAsPostsSource =
  | { kind: 'model'; model: ModelById }
  | {
      kind: 'model3d';
      id: number;
      creatorUserId: number;
    };

type ImagesAsPostsInfiniteState = {
  source: ImagesAsPostsSource;
  modelVersions?: ModelVersionsProps[];
  filters: {
    modelId?: number;
    model3dId?: number;
    username?: string;
    modelVersionId?: number;
  } & Record<string, unknown>;
  showModerationOptions?: boolean;
  /**
   * The effective browsing level the gallery query used (system level ∩ the
   * gallery's capped level). The lazy per-post carousel reuses it so its
   * `getInfinite({ postId })` tail fetch returns the SAME visible set the feed
   * slice + `imageCount` were computed from.
   */
  browsingLevel?: number;
  /**
   * Hidden-preference inputs the feed applied to the slice, forwarded so the lazy
   * carousel re-applies them to the fetched tail (content safety — the tail must
   * NOT surface gallery-owner-hidden / user-hidden / system-hidden-tagged /
   * poi/minor images the feed would have dropped).
   */
  hiddenImageIds?: number[];
  hiddenTags?: number[];
  hiddenUsers?: number[];
};
const ImagesAsPostsInfiniteContext = createContext<ImagesAsPostsInfiniteState | null>(null);
export const useImagesAsPostsInfiniteContext = () => {
  const context = useContext(ImagesAsPostsInfiniteContext);
  if (!context) throw new Error('ImagesInfiniteContext not in tree');
  return context;
};

export function ImagesAsPostsInfiniteProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: ImagesAsPostsInfiniteState;
}) {
  return (
    <ImagesAsPostsInfiniteContext.Provider value={value}>
      {children}
    </ImagesAsPostsInfiniteContext.Provider>
  );
}
