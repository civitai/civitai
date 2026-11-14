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

/**
 * The uuids of the body images a reader at `browsingLevel` may be sent: scanned, not awaiting
 * review, not a violation, and rated wholly within the level (unrated never is).
 */
export function servableBodyImageUrls(images: ArticleBodyImageState[], browsingLevel: number) {
  return new Set(
    images
      .filter(
        (image) =>
          servableArticleImage(image) !== null &&
          !image.tosViolation &&
          isRatingWithinCap(image.nsfwLevel, browsingLevel)
      )
      .map((image) => image.url)
  );
}

/** Drops every `img` and `edge-media` whose uuid is not in `keep`, including one with no uuid. */
export function removeBodyMediaExcept(html: string, keep: ReadonlySet<string>) {
  if (!html || !/<(img|edge-media)\b/i.test(html)) return html;
  return sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img')
        return !keep.has(extractCloudflareUuid(frame.attribs.src ?? '') ?? '');
      if (frame.tag === 'edge-media') return !keep.has(frame.attribs.url ?? '');
      return false;
    },
  });
}
