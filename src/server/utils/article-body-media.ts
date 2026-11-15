import sanitize from 'sanitize-html';
import { servableArticleImage } from '~/shared/utils/article-card-image';
import { isRatingWithinCap } from '~/shared/utils/rating-cap';
import { extractCloudflareUuid } from '~/utils/article-helpers';

export type ArticleBodyImageState = {
  url: string;
  nsfwLevel: number;
  ingestion: string;
  needsReview: string | null;
  tosViolation: boolean;
};

/** Scanned, not awaiting review and not a violation: what anyone but its owner and mods may get. */
export const isServableBodyImage = (image: ArticleBodyImageState) =>
  servableArticleImage(image) !== null && !image.tosViolation;

/** Held for csam review: withheld from everyone but moderators, its owner included. */
export const isCsamHeldBodyImage = (image: Pick<ArticleBodyImageState, 'needsReview'>) =>
  image.needsReview === 'csam';

/** Servable body images rated wholly within `browsingLevel` (unrated never is), by uuid. */
export function servableBodyImageUrls(images: ArticleBodyImageState[], browsingLevel: number) {
  return new Set(
    images
      .filter(
        (image) => isServableBodyImage(image) && isRatingWithinCap(image.nsfwLevel, browsingLevel)
      )
      .map((image) => image.url)
  );
}

/**
 * Drops every `img` and `edge-media` whose source names a `withheld` uuid and, given `keep`, every
 * one whose uuid is not in it, including one with no uuid. A link naming a withheld uuid loses
 * its href.
 */
export function removeBodyMedia(
  html: string,
  { keep, withheld }: { keep?: ReadonlySet<string>; withheld: readonly string[] }
) {
  if (!html || (!keep && !withheld.length) || !/<(img|edge-media|a)\b/i.test(html)) return html;
  const namesWithheld = (value: string | undefined) => {
    const lower = value?.toLowerCase() ?? '';
    return withheld.some((uuid) => lower.includes(uuid.toLowerCase()));
  };
  const kept = (uuid: string | null | undefined) => !keep || keep.has(uuid ?? '');
  return sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') {
        const src = frame.attribs.src ?? '';
        return !kept(extractCloudflareUuid(src)) || namesWithheld(src);
      }
      if (frame.tag === 'edge-media') {
        const url = frame.attribs.url ?? '';
        return !kept(url) || namesWithheld(url);
      }
      return false;
    },
    transformTags: {
      a: (tagName, attribs) => {
        if (!namesWithheld(attribs.href)) return { tagName, attribs };
        const { href: _href, ...rest } = attribs;
        return { tagName, attribs: rest };
      },
    },
  });
}
