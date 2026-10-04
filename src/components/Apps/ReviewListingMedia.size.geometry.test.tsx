import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
//
// 🔴 `geometry-setup`, NOT `component-setup`. This file used the component harness even after
// it was renamed into the geometry tier, and that harness injects its own `:root` block —
// "the one thing this harness exists to avoid", in geometry-setup's words. It changed no
// number measured here (the injected values match the real cascade's), but importing the
// stylesheet-free harness into the stylesheet tier is how this file's original defect arose.
import {
  LOADABLE_IMAGE_DATA_URI,
  cascadeEvidence,
  renderWithProviders,
} from '../../../test/geometry-setup';
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
 * 🔴 MEASURED AT THREE NAMED VIEWPORTS — 1280, 820 and 280 — because "larger" is a claim about
 * a layout and a layout is a function of width. At 1280 and 820 the 320px cover never reaches
 * its container, so it renders at its declared box; at 280 it must give way, which is where
 * the SHAPE of the give-way is checked. 390, the obvious "phone" number, is not narrow enough
 * — measured, the container is still wider than the cover there. 1280 is the desktop the page
 * is designed for; 820 is a tablet at which a fixed 320px cover could plausibly have
 * overflowed. A single measurement would carry no scope.
 *
 * ⚠️ `max-width: 100%` IS NOT WHAT ANY ARM HERE PROVES, and an earlier version of this
 * docstring claimed it was. Measured: deleting it leaves every test green, because flex shrink
 * narrows the cover to 246px at the 280 viewport — already inside the 280 the percentage
 * resolves to. The narrow arm is load-bearing for the RATIO under shrink, not for the clamp. The gallery's breakpoint was chosen so the claim holds at
 * BOTH: breaking at `lg` would have made the review gallery identical to the modal's at 1280,
 * i.e. invisible exactly where the page is used.
 *
 * ⚠️ WHAT THIS FILE DOES NOT COVER: the ROW surfaces. The shared thumbs keep `'row'` as their
 * default and the first case pins both sets of CONSTANTS, so a future "just make the constant
 * bigger" lands here rather than doubling the height of every queue row. But no case here
 * RENDERS a row-size thumb, so the row box's rendered geometry is unmeasured. The style object
 * is shared and unbranched, which is what makes the review arms mutation-tests for the row
 * path too — the day that object branches on `size`, the row path loses all pixel coverage.
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

/** The three widths every claim below is scoped to (the third is `PHONE`, just below). */
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
 * 🔴 A NON-SQUARE FIXTURE, AND IT IS LOAD-BEARING FOR THE ICON.
 *
 * `LOADABLE_IMAGE_DATA_URI` is 1x1. On the SQUARE icon box a 1:1 natural ratio makes
 * `height: auto` produce the correct number by coincidence, so deleting the icon's CSS box
 * left this whole suite green — measured. The cover's defect was only visible because its box
 * is 16:9 while the fixture is 1:1, i.e. the fixture could discriminate one box and not the
 * other. 2x1 mismatches BOTH boxes, so one fixture covers both halves.
 */
const NON_SQUARE_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGP8z8Dwn4GBgQEADQUCAOAHawIAAAAASUVORK5CYII=';

/**
 * 🔴 WAIT FOR THE DECODE BEFORE MEASURING, OR THE MEASUREMENT IS OF THE ATTRIBUTES.
 *
 * `expect.element(...).toBeInTheDocument()` resolves while the image is still loading, and
 * BEFORE decode Chromium derives the box from the `width`/`height` ATTRIBUTES — which is
 * exactly the value these tests assert. Measured under a mutation that deletes the CSS box:
 * pre-decode `320x180, complete=false, natural=0x0`; post-decode `320x320`. So the first test
 * to render an `img` always read the healthy pre-decode value and the defect was caught only
 * by a LATER test, off a decode the earlier one had warmed. The protection was file ORDER: a
 * reorder, a dropped arm, a `.only` or a `-t` filter and the defect ships green.
 */
const settled = async (testId: string) => {
  const img = document.querySelector<HTMLImageElement>(`[data-testid="${testId}"]`);
  expect(img, `${testId} must be on screen`).not.toBeNull();
  if (!img!.complete) {
    await new Promise((resolve) => img!.addEventListener('load', resolve, { once: true }));
  }
  await img!.decode();
  return img!;
};

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

/**
 * 🔴 THE POSITIVE CONTROL FOR THE WHOLE FILE, AND IT IS NOT OPTIONAL.
 *
 * Every height assertion here is only meaningful because Tailwind preflight is loaded and
 * outranks the `img` `width`/`height` attributes. That is precisely what was absent when this
 * file lived in the `component` tier: the attributes won, the boxes looked correct, and the
 * suite was green with the production defect live. So if `globals.css` ever stops loading in
 * this tier, this file silently reverts to measuring that same wrong, internally-consistent
 * layout — and nothing else in it would notice.
 *
 * `probeBoxSizing === 'border-box'` is preflight specifically (the UA default is
 * `content-box`), and the rule count separates a loaded stylesheet from an injected handful.
 */
describe('the harness itself', () => {
  test('🔴 the real cascade is loaded — without it every box below is a harness artefact', () => {
    const evidence = cascadeEvidence();
    expect(evidence.probeBoxSizing, 'Tailwind preflight must be in the cascade').toBe('border-box');
    expect(evidence.ruleCount, 'a loaded stylesheet, not an injected handful').toBeGreaterThan(
      1000
    );
  });
});

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
        iconUrl={NON_SQUARE_IMAGE_DATA_URI}
        coverUrl={`${NON_SQUARE_IMAGE_DATA_URI}#cover`}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();

    // 🔴 BOTH DECODES, BEFORE EITHER MEASUREMENT — see `settled`. And the fixture's own ratio
    // is the premise the whole suite rests on, so assert it rather than trusting the constant.
    const iconEl = await settled('apps-review-listing-icon-gen-matrix');
    const coverEl = await settled('apps-review-listing-cover-gen-matrix');
    expect(
      iconEl.naturalWidth,
      'the fixture must NOT be square, or neither box can be discriminated'
    ).not.toBe(iconEl.naturalHeight);

    const icon = box('apps-review-listing-icon-gen-matrix');
    const cover = box('apps-review-listing-cover-gen-matrix');
    expect(coverEl.complete).toBe(true);

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
    // ⚠️ WHAT NARROWS THE COVER HERE IS FLEX SHRINK, NOT `max-width: 100%` — measured, and the
    // earlier version of this comment claimed the opposite. At a 280px viewport the cover is
    // 246px wide, i.e. already below the 280px the percentage resolves to, so `max-width`
    // never binds: deleting it leaves this suite green. The `img` is a flex item at the
    // default `flex: 0 1 auto`, and that is what gives way. `max-width` stays as
    // belt-and-braces for any future non-flex parent; it is not what this arm proves.
    // What this arm DOES prove is the shape under shrink, below.
    await atWidth(
      PHONE,
      <ReviewListingMedia
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={NON_SQUARE_IMAGE_DATA_URI}
        coverUrl={`${NON_SQUARE_IMAGE_DATA_URI}#cover`}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    await settled('apps-review-listing-cover-gen-matrix');
    const cover = box('apps-review-listing-cover-gen-matrix');
    const c = container();
    expect(c.width, 'the container must actually be narrower than the cover box').toBeLessThan(
      REVIEW_COVER_W
    );
    expect(cover.width, 'the cover stays inside the container').toBeLessThanOrEqual(c.width + 1);
    expect(cover.width, 'and it has actually given way').toBeLessThan(REVIEW_COVER_W);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1
    );

    // 🔴 AND THE RATIO SURVIVES THE SHRINK. This is the assertion this arm was missing: it
    // entered the one width regime where the box gives way and then said nothing about what
    // that does to the SHAPE. A fixed `height` does not follow a narrowed width, so the pair
    // gave 246x180 (1.37) here while this file's own subject promised 16:9. Red against a
    // fixed `height` (measured 1.37 vs 1.78), green against `aspect-ratio`.
    expect(cover.width / cover.height, 'the clamped cover is still 16:9').toBeCloseTo(
      REVIEW_COVER_W / REVIEW_COVER_H,
      1
    );
  });

  test('🔴 under the clamp a MISSING cover still matches a present one — parity is width-independent', async () => {
    // ⚠️ INVARIANT GUARD, not a regression test: parity held before the `aspect-ratio` change
    // too, because both boxes were a fixed 180 tall. It is pinned because the fix had to move
    // BOTH of them — an `aspect-ratio` img against a fixed-height placeholder would have made
    // a no-cover listing taller than a cover one at every width below the box, and the
    // existing parity case runs at DESKTOP where the clamp cannot bind.
    // ONE render with two instances, not two renders: `renderWithProviders` does not unmount
    // the previous tree, so a second `atWidth` in the same test leaves both on screen and
    // every unscoped `data-testid` resolves to 2 elements. The slug-scoped ids stay unique,
    // and stacking them means both are measured at the same viewport in the same pass.
    await atWidth(
      PHONE,
      <>
        <ReviewListingMedia
          slug="has-cover"
          name="Has Cover"
          iconUrl={NON_SQUARE_IMAGE_DATA_URI}
          coverUrl={`${NON_SQUARE_IMAGE_DATA_URI}#cover`}
        />
        <ReviewListingMedia
          slug="no-cover"
          name="No Cover"
          iconUrl={NON_SQUARE_IMAGE_DATA_URI}
          coverUrl={null}
        />
      </>
    );
    await expect
      .element(page.getByTestId('apps-review-listing-cover-has-cover'))
      .toBeInTheDocument();
    await settled('apps-review-listing-cover-has-cover');

    const present = box('apps-review-listing-cover-has-cover');
    const absent = box('apps-review-listing-cover-placeholder-no-cover');

    // The clamp must actually be binding, or this asserts parity at a width where both are
    // simply their declared box — the vacuity the whole PHONE arm exists to avoid.
    expect(present.width, 'the clamp must be binding').toBeLessThan(REVIEW_COVER_W);
    expect(absent.width, 'same clamped width').toBeCloseTo(present.width, 0);
    expect(absent.height, 'same clamped height').toBeCloseTo(present.height, 0);
  });

  test('🔴 the ratio is preserved, so a bigger box is not a differently-cropped one', async () => {
    await atWidth(
      DESKTOP,
      <ReviewListingMedia
        slug="gen-matrix"
        name="Gen Matrix"
        iconUrl={NON_SQUARE_IMAGE_DATA_URI}
        coverUrl={`${NON_SQUARE_IMAGE_DATA_URI}#cover`}
      />
    );
    await expect.element(page.getByTestId('apps-review-listing-media')).toBeInTheDocument();
    await settled('apps-review-listing-icon-gen-matrix');
    await settled('apps-review-listing-cover-gen-matrix');
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
