import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

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
