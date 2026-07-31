/**
 * Unified listing detail — IN-PAGE LIVE PREVIEW view-model (pure, React-free).
 *
 * Decides (a) whether a listing can show a live preview at all, (b) what poster
 * image stands in for it before activation, and (c) whether the `<iframe>` is
 * mounted yet. Pure so the coverage lives in the node `unit` project — the
 * fast, deterministic suite CI runs on every PR (the browser component suites
 * are not run in CI at all).
 *
 * 🔴 POSTER-FIRST IS THE WHOLE POINT. `shouldMountPreviewIframe` is FALSE until
 * the viewer clicks: a store page that boots one third-party iframe per visit
 * pays that app's full JS/network cost for every shopper, on every listing view.
 * Before the click we render a static poster (the listing's own cover, else its
 * first screenshot, else a neutral placeholder). Nothing about this is HTTP
 * caching — block HTML is deliberately `Cache-Control: no-store` at the platform
 * layer so CSP/CORS changes propagate, and this module must never be read as a
 * licence to change that.
 *
 * SANDBOX PARITY with the legacy `/apps/[appBlockId]` preview
 * (`sandbox="allow-scripts allow-same-origin"`, `referrerPolicy="no-referrer"`):
 * the block is served from its OWN `<slug>.civit.ai` origin, so
 * `allow-same-origin` grants the frame ITS OWN origin — NOT the parent's. It is
 * what lets the block use its own storage/cookies; it does not give it any
 * access to civitai.com. Dropping `allow-scripts` would break every block;
 * dropping `allow-same-origin` would give it an opaque origin and break the
 * ones that persist state. Keep both, and keep the pair together.
 */

import { safeExternalHref } from '~/components/Apps/appListingCardView';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/** Sandbox token list for the preview frame. See the module docstring for why
 *  `allow-same-origin` is safe here (own-origin block subdomain). */
export const LISTING_PREVIEW_SANDBOX = 'allow-scripts allow-same-origin';

/** Rendered height of the activated preview frame (px). */
export const LISTING_PREVIEW_HEIGHT = 420;

export type ListingPreview = {
  /** The https-guarded standalone block origin to frame. */
  liveUrl: string;
  /** Static poster shown BEFORE activation, or null → neutral placeholder. */
  posterUrl: string | null;
  /** `<iframe title>` — names the framed app for assistive tech. */
  frameTitle: string;
};

/**
 * The preview descriptor for a listing, or `null` when the listing has nothing
 * to frame.
 *
 * Only ON-SITE listings are previewable: an off-site app is somebody else's
 * site — we neither host it nor control its framing headers, and the store
 * already discloses that it runs entirely off-platform. `liveUrl` is re-guarded
 * to https here (defense in depth; the DTO already guards it) so a malformed
 * value can never become an `<iframe src>`.
 */
export function getListingPreview(
  detail: Pick<ListingDetail, 'name' | 'coverUrl' | 'screenshots' | 'kindData'>
): ListingPreview | null {
  if (detail.kindData.kind !== 'onsite') return null;
  const liveUrl = safeExternalHref(detail.kindData.liveUrl);
  if (!liveUrl) return null;
  return {
    liveUrl,
    posterUrl: getPreviewPosterUrl(detail),
    frameTitle: `${detail.name} live preview`,
  };
}

/**
 * Poster source, in order: the listing cover → the first screenshot → `null`.
 * `null` is a normal, expected outcome (several approved listings ship neither),
 * and the caller must still render an ACTIVATABLE neutral placeholder for it —
 * a listing without art must not lose its preview.
 */
export function getPreviewPosterUrl(
  detail: Pick<ListingDetail, 'coverUrl' | 'screenshots'>
): string | null {
  if (detail.coverUrl) return detail.coverUrl;
  const shot = (detail.screenshots ?? []).find((s) => !!s?.url);
  return shot?.url ?? null;
}

/**
 * Is the `<iframe>` mounted? FALSE until the viewer activates the preview —
 * this is the poster-then-activate contract, and the reason no third-party
 * frame boots on page load.
 */
export function shouldMountPreviewIframe(opts: {
  preview: ListingPreview | null;
  activated: boolean;
}): boolean {
  return !!opts.preview && opts.activated;
}
