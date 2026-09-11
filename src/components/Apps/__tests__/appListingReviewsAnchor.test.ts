import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LISTING_REVIEWS_ANCHOR_ID } from '~/components/Apps/listingKindLabels';
import { buildListingDetailRows } from '~/components/Apps/appListingDetailRows';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * 🔒 THE SEAM between the Details rail's "Reviews" LINK and the reviews SECTION it
 * jumps to.
 *
 * ## Why a guard, when both sides are three lines of obvious code
 *
 * 🔴 BECAUSE THIS SEAM FAILS SILENTLY. An `href="#x"` pointing at an id nothing
 * renders produces no error, no console warning and no visual difference — the link
 * looks exactly like a working one and does nothing when clicked. Neither side is
 * wrong on its own; only the RELATIONSHIP can be wrong, and nothing else in the tree
 * observes it. Renaming the section's `id`, or dropping it during an unrelated
 * refactor of that `Stack`, would ship a dead link that only a human who tried it
 * would ever notice — which is precisely how the row came to be reported as "not
 * clickable" in the first place.
 *
 * So this asserts the two ends AGREE, not that either end has a particular value.
 * Changing `LISTING_REVIEWS_ANCHOR_ID` keeps every assertion below green.
 *
 * ## What is deliberately NOT asserted
 *
 * That the link scrolls. That is the browser's job for a fragment link, it needs a
 * real layout, and a test that mocked it would be testing the mock. The browser-tier
 * sibling asserts the ANCHOR EXISTS with the right href; this file asserts the target
 * exists to receive it.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

function componentSource(): string {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'src/components/Apps/AppListingDetailBody.tsx'),
    'utf8'
  );
}

function detailFixture(over: Partial<ListingDetail> = {}): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: null,
    description: null,
    category: 'utility',
    contentRating: null,
    isBeta: false,
    betaMessage: null,
    iconUrl: null,
    coverUrl: null,
    creator: null,
    // Non-zero by default: the LINK only exists when there are reviews to jump to.
    recommend: { recommendedCount: 7, notRecommendedCount: 1, recommendPct: 0.875 },
    reviewCount: 8,
    installCount: 3,
    sourceRepoUrl: null,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    scopes: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

const rowsFor = (over: Partial<ListingDetail> = {}, preview = false) =>
  buildListingDetailRows(detailFixture(over), { preview, formatDate: () => 'some date' });

describe('reviews anchor — the link and its target', () => {
  it('🔴 the section renders the SAME id the row links to', () => {
    // The target half. Read from source because the id is set on a JSX element in a
    // branch this node-tier file cannot render.
    expect(componentSource()).toContain('id={LISTING_REVIEWS_ANCHOR_ID}');

    // The link half.
    const reviews = rowsFor().find((r) => r.key === 'reviews');
    expect(reviews?.anchorId).toBe(LISTING_REVIEWS_ANCHOR_ID);
  });

  it('🔴 the section id is NOT hardcoded — both ends must read the constant', () => {
    // The whole point of the constant. A literal on either side re-opens the drift
    // this file exists to close.
    const src = componentSource()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(new RegExp(`id=(["'\`])${LISTING_REVIEWS_ANCHOR_ID}\\1`));
  });

  it('there is NO link when there are no reviews — it would land on an empty heading', () => {
    const reviews = rowsFor({
      recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
      reviewCount: 0,
    }).find((r) => r.key === 'reviews');

    expect(reviews?.value).toBe('No reviews yet');
    expect(reviews?.anchorId).toBeUndefined();
  });

  it('🔴 there is NO link in PREVIEW — the section is not rendered in that posture', () => {
    // The dangerous case: the moderator preview omits the reviews section entirely,
    // so an anchor emitted there would point at an id that does not exist on the page.
    // The row is gated out in preview today; this pins that the LINK cannot outlive
    // the row if that ever changes.
    const reviews = rowsFor({}, true).find((r) => r.key === 'reviews');
    expect(reviews?.anchorId).toBeUndefined();
  });

  it('the reviews link does NOT use the outbound-link field', () => {
    // `href` obliges the renderer to emit target="_blank" + rel="noopener noreferrer".
    // Using it for a same-page fragment would open this page in a new tab, and would
    // quietly attach a security posture designed for third-party URLs to one that is
    // not. Two link kinds, two fields.
    const reviews = rowsFor().find((r) => r.key === 'reviews');
    expect(reviews?.href).toBeUndefined();
  });
});
