import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { isBlobUrl } from '~/utils/type-guards';

/**
 * A media URL for JSON-LD, or undefined when the media is not safe-rated. Structured data is read
 * by crawlers and link unfurlers that never see the page's rating gate, so it follows the same rule
 * as og:image and /api/og.
 */
export function safeSchemaImageUrl(
  image: { url?: string | null; nsfwLevel: number } | null | undefined,
  options?: Parameters<typeof getEdgeUrl>[1]
) {
  if (!image?.url || !getIsSafeBrowsingLevel(image.nsfwLevel)) return undefined;
  return getEdgeUrl(image.url, options);
}

/**
 * The profile page's schema image: the avatar when it is safe-rated. The account `image` field carries
 * no rating, so it is never a fallback.
 */
export function profileSchemaImageUrl(
  profilePicture: { url: string; nsfwLevel: number } | null | undefined
) {
  if (!profilePicture || isBlobUrl(profilePicture.url)) return undefined;
  return safeSchemaImageUrl(profilePicture, { width: 1200 });
}
