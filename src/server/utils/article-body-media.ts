import type { DB } from '@civitai/db-schema/kysely';
import type { Selectable } from 'kysely';
import sanitize from 'sanitize-html';
import { isMinorMatureImage } from '~/server/common/image-visibility';
import { keysIn } from '~/server/services/image-url-ownership';
import { servableArticleImage } from '~/shared/utils/article-card-image';
import { isRatingWithinCap } from '~/shared/utils/rating-cap';
import { extractCloudflareUuid } from '~/utils/article-helpers';

export type ArticleBodyImageState = Pick<
  Selectable<DB['Image']>,
  'url' | 'nsfwLevel' | 'ingestion' | 'needsReview' | 'tosViolation' | 'modelRestricted'
>;

/** Scanned, rated, not awaiting review, not a violation and not restricted by its base model. */
const isClearedBodyImage = (image: ArticleBodyImageState) =>
  servableArticleImage(image) !== null && !image.tosViolation;

/**
 * What anyone but its owner and mods may get: cleared, and not a minor-flagged image the minor
 * content rule restricts (`isMinorMatureImage`).
 */
export const isServableBodyImage = (image: ArticleBodyImageState & { minor: boolean | null }) =>
  isClearedBodyImage(image) && !isMinorMatureImage(image);

/** The `needsReview` of an image held for csam review. */
export const CSAM_HELD_REVIEW = 'csam';

/** Held for csam review: withheld from everyone but moderators, its owner included. */
export const isCsamHeldBodyImage = (image: Pick<ArticleBodyImageState, 'needsReview'>) =>
  image.needsReview === CSAM_HELD_REVIEW;

/**
 * Cleared body images rated wholly within `browsingLevel` (unrated never is), by uuid. For images
 * `getArticleById` already narrowed to what this viewer may get.
 */
export function servableBodyImageUrls(images: ArticleBodyImageState[], browsingLevel: number) {
  return new Set(
    images
      .filter(
        (image) => isClearedBodyImage(image) && isRatingWithinCap(image.nsfwLevel, browsingLevel)
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
  if (!keep && !held.length && edgeMediaAllKept(html, keepEdgeMedia)) return html;
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
    // Only silences the per-call warning that script and style pass through; output is unchanged
    // (the body as stored, minus media). The result is NOT sanitised: render it through RenderHtml
    // or strip its tags, never insert it as HTML directly.
    allowVulnerableTags: true,
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

const EDGE_MEDIA_TAG = /<edge-media\b[^>]*>/gi;
const URL_ATTRIBUTE = /\burl\s*=/gi;
const BARE_UUID_URL = /\surl="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;

/**
 * Whether every `edge-media` plainly names one bare uuid that `keepEdgeMedia` (if given) holds, so
 * the parse can be skipped. Anything it cannot read that way answers false and gets the full parse.
 */
function edgeMediaAllKept(html: string, keepEdgeMedia: ReadonlySet<string> | undefined) {
  for (const [tag] of html.matchAll(EDGE_MEDIA_TAG)) {
    const uuid = BARE_UUID_URL.exec(tag)?.[1];
    if (!uuid || tag.match(URL_ATTRIBUTE)?.length !== 1) return false;
    if (keepEdgeMedia && !keepEdgeMedia.has(uuid)) return false;
  }
  return true;
}
