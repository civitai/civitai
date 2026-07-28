import { hasSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';

/**
 * Whether ads must be suppressed for this content on civitai.com.
 *
 * Deliberately not the `Gated` verdict: .com serves PG and PG13, so a PG13 page is ad-safe
 * even when the viewer sees a login gate instead of the content. Keying off gate state would
 * kill ads on every PG13 page for logged-out users — most of the site's ad traffic.
 *
 * Viewer-independent so the answer is identical for every request to a URL: one auction from
 * an owner, mod, or crawler is enough to put the URL in GAM's policy violation center.
 */
export function isAdGatedContent({
  contentNsfwLevel,
  nsfw,
}: {
  contentNsfwLevel: number;
  nsfw?: boolean;
}) {
  return !!nsfw || !hasSafeBrowsingLevel(contentNsfwLevel);
}
