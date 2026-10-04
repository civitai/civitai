import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { LOADABLE_IMAGE_DATA_URI, renderWithProviders } from '../../../test/component-setup';
import {
  LISTING_COVER_H,
  LISTING_COVER_W,
  LISTING_ICON_BOX,
  REVIEW_COVER_H,
  REVIEW_COVER_W,
  REVIEW_ICON_BOX,
} from '~/components/Apps/ListingMediaThumb';

/**
 * THE REVIEW PAGE'S MEDIA IS BIG ENOUGH TO JUDGE.
 *
 * 🔴 WHY THIS IS A SIZE TEST AND NOT A STYLE NIT. `ScreenshotsReviewPanel`'s own comment
 * records why it exists: publisher-supplied images are an abuse vector, so a moderator has to
 * SEE them before approving. The store icon and cover are the same argument one surface over
 * — and both were rendering at the TABLE-ROW box (40×40, 96×54) that `/apps/mine` and the
 * review queue need. A thumbnail too small to assess is the same as not showing it, so the
 * size is part of the feature, not of its appearance.
 *
 * 🔴 THE `geometry` TIER, NOT `component` — and moving it is what found a real defect. As a
 * `.browser.test.tsx` this ran in a document with 24 CSS rules, where every height number was
 * a property of the harness: Tailwind preflight was absent, so the `img` `height` ATTRIBUTE
 * won and the box looked reserved. Renamed into geometry (3,677 rules) the cover read
 * 320x320 against an asserted 320x180 — preflight's `height: auto` outranks a presentational
 * hint, so the cover's height was tracking the publisher's art. A pixel assertion in a tier
 * that loads no stylesheet measures a different, internally-consistent layout, which is worse
 * than measuring nothing.
 *
 * 🔴 MEASURED AT THREE NAMED VIEWPORTS — 1280, 820 and 390 — because "larger" is a claim about
 * a layout and a layout is a function of width. The narrow one is not decoration: at 1280 and
 * 820 the 320px cover never reaches its container, so `max-width: 100%` is provably INERT and
 * the arms that cite it prove nothing about it. 280 is below the box, so the clamp binds —
 * and 390, the obvious "phone" number, is NOT: measured, the container is still wider than
 * the cover there, so that arm would have been a third vacuous one. 1280 is the desktop the page is designed for;
 * 820 is a tablet at which a fixed 320px cover could plausibly have overflowed its container.
 * A single measurement would carry no scope, and the overflow half of the claim is only
 * interesting at the narrow one. The gallery's breakpoint was chosen so the claim holds at
 * BOTH: breaking at `lg` would have made the review gallery identical to the modal's at 1280,
 * i.e. invisible exactly where the page is used.
 *
 * ⚠️ THE ROW SIZE IS NOT REGRESSED. The shared thumbs keep `'row'` as their default, and the
 * first case pins both boxes so a future "just make the constant bigger" lands here rather
 * than doubling the height of every queue row.
 */

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true }),
}));

/*
  🔴 SPREAD THE REAL MODULE, then override `trpc`. A wholesale factory replaces
  `~/utils/trpc` entirely, so the day it gains an export this object omits, every importer in
  the module graph gets `undefined` and the WHOLE FILE fails to load — 0 tests collected, no
  failing assertion. This PR hit exactly that four times over `~/utils/notifications`.
*/
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      blocks: {
        getPublishRequestScreenshots: {
          useQuery: () => ({
            data: {
              items: [
                { index: 0, dataUrl: LOADABLE_IMAGE_DATA_URI },
                { index: 1, dataUrl: `${LOADABLE_IMAGE_DATA_URI}#2` },
              ],
            },
            isLoading: false,
            error: null,
          }),
        },
      },
    },
  };
});

const { ReviewListingMedia } = await import('./ReviewListingMedia');
const { ScreenshotsReviewPanel } = await import('./OnsiteReviewModal');

/** The two widths every claim below is scoped to. */
const DESKTOP = 1280;
const TABLET = 820;
/**
 * A width at which the 320px cover genuinely MEETS its container.
 *
 * ⚠️ 390 (a modern phone) is NOT narrow enough — measured, the container is still 390 and the
 * 320px box fits with room to spare, so an arm at that width asserts the clamp without
 * exercising it, which is the same vacuity as the two wide arms. 280 is below the box.
 */
const PHONE = 280;

/**
 * Sets the real VIEWPORT, then renders inside a full-width container.
 *
 * 🔴 THE VIEWPORT, NOT A CONTAINER WIDTH — and the first version of this file got that wrong,
 * which is worth recording because the failure was a false EQUALITY rather than an error.
 * Mantine's `SimpleGrid cols={{ base, sm, lg }}` resolves against media queries, so wrapping
 * the two galleries in differently-sized `div`s changed nothing: both rendered the same
 * column count and the "review is wider" assertion read `414 > 414`. A container-width
 * harness cannot measure a viewport-breakpoint layout at all.
 */
const atWidth = async (width: number, ui: React.ReactElement) => {
  await page.viewport(width, 900);
  return renderWithProviders(
    <div data-testid="page-container" style={{ width: '100%' }}>
      {ui}
    </div>
  );
};

const box = (testId: string) => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(el, `${testId} must be on screen`).not.toBeNull();
  return el!.getBoundingClientRect();
};

const container = () => box('page-container');

describe('the store icon and cover are bigger on the review page than in a queue row', () => {
  test.each([
    ['desktop', DESKTOP],
    ['tablet', TABLET],
  ] as const)('🔴 at %s (%ipx) both boxes exceed the table-row size', async (_label, width) => {
    await atWidth(
      width,
      <ReviewListingMedia
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={LOADABLE_IMAGE_DATA_URI}
        coverUrl={`${LOADABLE_IMAGE_DATA_URI}#cover`}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();

    const icon = box('apps-review-listing-icon-gen-matrix');
    const cover = box('apps-review-listing-cover-gen-matrix');

    // 🔴 STRICTLY GREATER THAN THE ROW CONSTANT, not "equals the new constant". Asserting the
    // new number alone would pass if someone set BOTH constants to the same value, which is
    // the change this guard exists to stop.
    expect(
      icon.width,
      `icon ${icon.width} must exceed the row box ${LISTING_ICON_BOX}`
    ).toBeGreaterThan(LISTING_ICON_BOX);
    expect(
      cover.width,
      `cover ${cover.width} must exceed the row box ${LISTING_COVER_W}`
    ).toBeGreaterThan(LISTING_COVER_W);
    expect(cover.height).toBeGreaterThan(LISTING_COVER_H);

    // …and they are the declared review boxes, so the sizes are a decision rather than
    // whatever the layout happened to give.
    expect(icon.width).toBeCloseTo(REVIEW_ICON_BOX, 0);
    expect(icon.height).toBeCloseTo(REVIEW_ICON_BOX, 0);
    expect(cover.width).toBeCloseTo(REVIEW_COVER_W, 0);
    expect(cover.height).toBeCloseTo(REVIEW_COVER_H, 0);

    // 🔴 STILL BOUNDED. A fixed 320px box must never be the reason a page scrolls sideways.
    const c = container();
    expect(icon.width).toBeLessThanOrEqual(c.width + 1);
    expect(cover.width).toBeLessThanOrEqual(c.width + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1
    );
  });

  test('🔴 at phone width (280px) the cover CLAMPS to its container instead of widening the page', async () => {
    // The arm that makes `max-width: 100%` load-bearing. At 1280 and 820 a 320px box never
    // meets its container, so those arms assert the clamp without ever exercising it.
    await atWidth(
      PHONE,
      <ReviewListingMedia
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={LOADABLE_IMAGE_DATA_URI}
        coverUrl={`${LOADABLE_IMAGE_DATA_URI}#cover`}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    const cover = box('apps-review-listing-cover-gen-matrix');
    const c = container();
    expect(c.width, 'the container must actually be narrower than the cover box').toBeLessThan(
      REVIEW_COVER_W
    );
    expect(cover.width, 'the cover clamps to the container').toBeLessThanOrEqual(c.width + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1
    );
  });

  test('🔴 the ratio is preserved, so a bigger box is not a differently-cropped one', async () => {
    await atWidth(
      DESKTOP,
      <ReviewListingMedia
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={LOADABLE_IMAGE_DATA_URI}
        coverUrl={`${LOADABLE_IMAGE_DATA_URI}#cover`}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    const cover = box('apps-review-listing-cover-gen-matrix');
    expect(cover.width / cover.height).toBeCloseTo(LISTING_COVER_W / LISTING_COVER_H, 1);
    const icon = box('apps-review-listing-icon-gen-matrix');
    expect(icon.width / icon.height).toBeCloseTo(1, 1);
  });

  test('🔴 a MISSING cover reserves the SAME big box — present and absent must not reflow', async () => {
    // The placeholder is the other half of the CLS reservation, and it is the one a
    // "make it bigger" change silently leaves behind.
    await atWidth(
      DESKTOP,
      <ReviewListingMedia slug="gen-matrix" name="Gen Matrix" iconUrl={null} coverUrl={null} />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    const icon = box('apps-review-listing-icon-placeholder-gen-matrix');
    const cover = box('apps-review-listing-cover-placeholder-gen-matrix');
    expect(icon.width).toBeCloseTo(REVIEW_ICON_BOX, 0);
    expect(cover.width).toBeCloseTo(REVIEW_COVER_W, 0);
    expect(cover.height).toBeCloseTo(REVIEW_COVER_H, 0);
  });
});

describe('the bundle screenshots are bigger on the review page than in the modal', () => {
  /** The grid Mantine rendered, and the column count it DECLARED. */
  const declaredCols = () => {
    const shot = document.querySelector<HTMLElement>('[data-testid="apps-review-screenshot-0"]')!;
    const grid = shot.closest('div')!.parentElement!;
    return getComputedStyle(grid).getPropertyValue('--sg-cols').trim();
  };

  test.each([
    ['desktop', DESKTOP],
    ['tablet', TABLET],
  ] as const)(
    '🔴 at %s (%ipx) a review shot is ONE column, fills the container, and does not overflow it',
    async (_label, width) => {
      await atWidth(width, <ScreenshotsReviewPanel publishRequestId="pubreq_1" size="review" />);
      await expect.element(page.getByTestId('apps-review-screenshot-0')).toBeInTheDocument();

      // 🔴 THE DECLARED COLUMN COUNT IS THE LOAD-BEARING ASSERTION. Measured by mutation:
      // reverting the review gallery to the modal's responsive `{ base: 1, sm: 2 }` leaves
      // every WIDTH assertion in this file green, and only this one moves.
      //
      // ⚠️ AND THE REASON IS NOT THE ONE AN EARLIER DRAFT RECORDED. That draft blamed media
      // queries "not applying". Measured directly: `matchMedia('(min-width: 48em)')` is true
      // at 1280 and 820 and false at 600, and `--sg-cols` reads 2 / 2 / 1 — the responsive
      // value resolves correctly. What was absent in the old `component` tier was
      // SimpleGrid's LAYOUT CSS, so the grid was never a grid and both arms filled the
      // container. The distinction matters because the two diagnoses lead to different
      // fixes, and someone "fixing the media queries" would chase nothing.
      expect(declaredCols(), 'the review gallery must declare a single column').toBe('1');

      const shot = box('apps-review-screenshot-0');
      const c = container();
      expect(shot.width, `a review shot should fill the ${c.width}px container`).toBeGreaterThan(
        c.width * 0.9
      );
      // 🔴 AND STILL BOUNDED. `max-width: 100%` is what stops a wide image widening the page.
      expect(shot.width).toBeLessThanOrEqual(c.width + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth + 1
      );
    }
  );

  test('🔴 NEGATIVE CONTROL: the MODAL variant declares something OTHER than one column', async () => {
    // Without this, the assertion above is satisfied by a panel that ignores `size` and is
    // single-column everywhere — which is what a dropped prop looks like, and would also
    // regress the modal.
    await atWidth(DESKTOP, <ScreenshotsReviewPanel publishRequestId="pubreq_1" />);
    await expect.element(page.getByTestId('apps-review-screenshot-0')).toBeInTheDocument();
    expect(declaredCols(), 'the modal keeps its responsive two-up').not.toBe('1');
  });

  test('🔴 the laziness is unchanged — a bigger image is not an eagerly fetched one', async () => {
    // These are base64 data URLs inlined in the query payload. Widening the column changes
    // the layout, not when the bytes are decoded.
    await atWidth(DESKTOP, <ScreenshotsReviewPanel publishRequestId="pubreq_1" size="review" />);
    await expect
      .element(page.getByTestId('apps-review-screenshot-0'))
      .toHaveAttribute('loading', 'lazy');
  });
});
