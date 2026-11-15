import sanitize from 'sanitize-html';
import { keysIn } from '~/server/services/image-url-ownership';
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
 * one whose uuid is not in it, including one with no uuid. `keepEdgeMedia` does the same for
 * `edge-media` alone, which only ever holds site media; one with no uuid is always dropped. A link
 * naming a withheld uuid loses its href.
 */
export function removeBodyMedia(
  html: string,
  {
    keep,
    keepEdgeMedia = keep,
    withheld,
  }: {
    keep?: ReadonlySet<string>;
    keepEdgeMedia?: ReadonlySet<string>;
    withheld: readonly string[];
  }
) {
  const held = withheld.filter(Boolean).map((uuid) => uuid.toLowerCase());
  if (!html || !/<(img|edge-media|a)\b/i.test(html)) return html;
  if (!keep && !keepEdgeMedia && !held.length && !/<edge-media\b/i.test(html)) return html;
  const heldKeys = new Set(held);
  // keysIn reads the uuid however the url spells it, as the browser would resolve it.
  const namesWithheld = (value: string | undefined) => {
    if (!value) return false;
    const lower = value.toLowerCase();
    return held.some((uuid) => lower.includes(uuid)) || keysIn(value).some((k) => heldKeys.has(k));
  };
  const kept = (uuid: string | null | undefined, set = keep) => !set || set.has(uuid ?? '');
  return sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    // Only media is removed; every other href and src is left as stored.
    allowedSchemesAppliedToAttributes: [],
    exclusiveFilter: (frame) => {
      if (frame.tag === 'img') {
        const src = frame.attribs.src ?? '';
        return !kept(extractCloudflareUuid(src)) || namesWithheld(src);
      }
      if (frame.tag === 'edge-media') {
        const url = frame.attribs.url ?? '';
        const uuid = extractCloudflareUuid(url);
        return !uuid || !kept(uuid, keepEdgeMedia) || namesWithheld(url);
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
