import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { ownerOrModeratorViewer } from '~/server/auth/full-user-credential';
import { eventViewerOf } from '~/server/events/event-viewer';
import { canViewOwnerOnly } from '~/server/utils/poi-model-visibility';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';

type ArticleLevels = {
  nsfwLevel: number;
  contentImages?: { nsfwLevel: number }[] | null;
};

/**
 * Whether an article may be served in a restricted region: it and every connected (Civitai-hosted)
 * image in its body are rated SFW; unrated fails closed. The images count too because a
 * moderator's override sets the article's own level. An article that fails this is answered
 * differently by region, so it must also stay out of any cache that does not key on region.
 */
export function isArticleServableWhenRestricted(article: ArticleLevels) {
  const levels = [article.nsfwLevel, ...(article.contentImages ?? []).map((i) => i.nsfwLevel)];
  return levels.every((level) => !!level && Flags.hasFlag(sfwBrowsingLevelsFlag, level));
}

/** The reader a region gate is asked about. The region is read only when the gate needs it. */
export type ArticleRegionReader = {
  isRestricted: () => boolean;
  viewer: { id?: number; isModerator?: boolean };
};

export function articleRegionReaderOf(
  ctx: Parameters<typeof eventViewerOf>[0] & { req: Parameters<typeof getRegion>[0] }
): ArticleRegionReader {
  // A moderator only on a session or a full-access personal key, as for moderatorProcedure.
  return { viewer: eventViewerOf(ctx), isRestricted: () => isRegionRestricted(getRegion(ctx.req)) };
}

/**
 * The caller, as the region reader reads them (blocks apply on any key), and the viewer linked
 * models and articles are shown to: the owner's view only on a session or a full-access key, and
 * moderator rights only as the region reader grants them.
 */
export function associatedResourcesReadersOf(
  ctx: Parameters<typeof articleRegionReaderOf>[0] & Parameters<typeof ownerOrModeratorViewer>[0]
) {
  const reader = articleRegionReaderOf(ctx);
  const viewer = { ...reader.viewer, id: ownerOrModeratorViewer(ctx)?.id };
  return [reader, viewer] as const;
}

/**
 * `withheld`: refuse this reader the article, as a missing one; its author and moderators still
 * read it. `regionDependent`: the answer differs by region, so keep it out of the edge cache.
 */
export function articleRegionGate(
  article: ArticleLevels & { userId: number | null },
  { isRestricted, viewer }: ArticleRegionReader
) {
  const regionDependent = !isArticleServableWhenRestricted(article);
  const exempt = canViewOwnerOnly(article.userId, viewer);
  return { withheld: regionDependent && !exempt && isRestricted(), regionDependent };
}
