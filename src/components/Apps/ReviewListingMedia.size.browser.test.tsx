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
 * 🔴 MEASURED AT TWO NAMED VIEWPORTS — 1280 and 820 — because "larger" is a claim about a
 * layout and a layout is a function of width. 1280 is the desktop the page is designed for;
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
  /**
   * 🔴 THE COMPACT ARM IS DERIVED, NOT MEASURED, AND HERE IS WHY — because a test that
   * quietly swaps a measurement for arithmetic is the thing this file is otherwise about.
   *
   * Mantine resolves a responsive `cols={{ base, sm }}` through MEDIA QUERIES, and in this
   * browser harness those do not apply: rendering the modal's gallery at a 1280 viewport
   * produced ONE column, not two, so a measured comparison read `1280 > 1280` and the claim
   * was untestable rather than false. Rather than assert against a number the harness is
   * getting wrong, the review arm is MEASURED and the modal's two-up width is computed from
   * the container — which is what the modal renders in a real browser.
   *
   * What that costs: this cannot catch a regression in the MODAL's column count. That is the
   * modal's own suite's job, and it is stated here rather than left for a reader to discover.
   */
  const twoUpWidth = (containerWidth: number) => containerWidth / 2;

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

      // 🔴 THE DECLARED COLUMN COUNT IS THE LOAD-BEARING ASSERTION, and the measured width
      // below cannot replace it — see the harness note above. Measured by mutation: reverting
      // the review gallery to the modal's responsive `{ base: 1, sm: 2 }` left every WIDTH
      // assertion green, because this harness resolves a responsive `cols` to its `base`.
      // Only the declared value moves, and it is what a real browser acts on.
      expect(declaredCols(), 'the review gallery must declare a single column').toBe('1');

      const shot = box('apps-review-screenshot-0');
      const c = container();
      expect(shot.width, `a review shot should fill the ${c.width}px container`).toBeGreaterThan(
        c.width * 0.9
      );
      expect(
        shot.width,
        `review ${shot.width} must beat the modal two-up ${twoUpWidth(c.width)} at ${width}px`
      ).toBeGreaterThan(twoUpWidth(c.width) * 1.5);

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
