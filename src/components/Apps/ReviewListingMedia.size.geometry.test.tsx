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
  flexLonghands,
  longhand,
  renderAtViewport,
} from '../../../test/geometry-setup';
import { ListingIconThumb } from '~/components/Apps/ListingMediaThumb';
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
 * ⚠️ `max-width: 100%` does different work on the two cover branches — inert on the `img`,
 * load-bearing on the placeholder. The measurement is recorded where the declaration lives,
 * on `coverBoxStyle` in `ListingMediaThumb.tsx`. The narrow arms here prove the RATIO under
 * shrink and the placeholder's clamp; they do not prove the img's.
 *
 * ⚠️ THE ROW SURFACES ARE COVERED FOR THE FLEX SHORTHAND AND `max-width` ONLY. Why the
 * row/review split matters is recorded on `iconBoxStyle` in `ListingMediaThumb.tsx`; what
 * matters here is that the tier caught that regression ONCE and then stopped — re-mutating it
 * at this head left the whole tier green, because the narrowest viewport any row-rendering
 * geometry TEST renders a row thumb at is 768, and the regression needs a narrower one. So
 * the case below asserts the longhands directly rather than hoping a width reproduces it —
 * cheap, and
 * width-independent. Everything else about the row box's rendered geometry is unmeasured.
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
 *
 * 🔴 EACH OF THE THREE GUARDS BELOW STOPS A DIFFERENT THING, AND THREE DRAFTS OF THIS
 * PARAGRAPH CREDITED THE WRONG ONE. Measured directly, by probing every corruption class:
 *
 *   `decode()` NEVER HANGS. On a dead payload Chromium sets `complete === true` with
 *   `naturalWidth === 0` and `decode()` REJECTS — `EncodingError`, in 0 ms — for a
 *   not-a-PNG, an empty payload and a dead IHDR alike. So `naturalWidth` prevents no hang.
 *   Its entire benefit is the NAME: without it the six failures are bare `EncodingError`s
 *   identifying nothing; with it each one says which testid. Time cost of the difference,
 *   measured: 1.04x. It is a legibility guard, not a liveness one.
 *
 *   THE TWO REAL NEVER-SETTLING PATHS ARE BOTH ON THE `load` AWAIT. A non-`<img>` has
 *   `complete === undefined`, so the await IS entered and no `load` ever fires — that is
 *   `toBeInstanceOf`'s job, and it is the one measured: delete it, aim one `settled()` at a
 *   placeholder id, and ONE test times out at 15 s, taking the tests phase from well under a
 *   second to roughly that timeout. (An earlier draft said "0 timeouts to 3" — that 3 was the
 *   number of LINES matching "Test timed out". Vitest prints that message more than once per
 *   timeout, and HOW many depends on the reporter: measured 3 with the dot reporter, 2 with
 *   verbose, for the same single timeout. The line count was never a timeout count under any
 *   reporter, and three 15 s timeouts could not fit the phase quoted beside it.)
 *   The second path is an `<img>` in flight whose load FAILS, firing `error` rather than
 *   `load` — that is the `error` listener's job. It does not FIRE on a healthy run, because
 *   no shipped fixture fails to load; what was measured is the half that matters, that the
 *   AWAIT is entered at all. An earlier draft called the listener unreachable "because data
 *   URIs complete synchronously" — true only of a URI the browser has already decoded.
 *   ⚠️ WHETHER THAT AWAIT IS ENTERED AT ALL IS A TIMING RACE, AND THREE SEPARATE
 *   INSTRUMENTED RUNS GAVE THREE ANSWERS. The question is only ever whether the data URI has
 *   finished loading by the time `settled()` runs, and `renderAtViewport` awaits first, so it
 *   usually has. On this machine under load (~12) the same arm read `complete=false` 5 times
 *   out of 5; a review lane on a quieter box read `complete=true` 6 arms out of 6; a third
 *   run split 5-of-6. Earlier drafts here blamed run shape — "any arm alone enters it", "a
 *   whole-file run warms it" — and that is not the variable. Machine load is.
 *
 *   SO TREAT THE `error` LISTENER AS DEFENSIVE, NOT AS EXERCISED. It fires only when a dead
 *   fixture happens to lose that race; with the shipped fixtures it never fires at all, and
 *   with a dead one the usual outcome is the `naturalWidth` guard below. An earlier draft
 *   said deleting it "would turn the first dead-fixture arm into a 15 s timeout" — measured,
 *   that happens in a minority of runs; most fall through to that guard and report in ~0.1 s.
 *   (A probe here must use an UNSEEN payload: re-running the same dead URI flips `complete`
 *   to true off the browser profile's cached failure.)
 *
 * ⚠️ Local figures here were measured on Chrome 149, not the pinned 143 — see `docs/dev/worktrees.md`,
 * "Browser/component tests on NixOS". CI runs the pin.
 *
 * ⚠️ IT CATCHES A HEADER-DEAD FIXTURE, NOT A PIXEL-DEAD ONE, and the narrower claim is the
 * true one. `naturalWidth` comes from the PNG IHDR, so corrupting only the IDAT run leaves a
 * decodable 2x1 and this guard never fires — measured, the whole file green. That is the right
 * outcome, since every assertion here is about the BOX and the box is still 2x1; it is
 * recorded so nobody reads this as fixture validation in general. The awaits are still the
 * right call — at the previous head the same corrupt fixture was SILENTLY GREEN, because a
 * fixed CSS height renders the right box whether or not any bytes arrive — but a guard should
 * fail with a sentence naming the fixture.
 */
const settled = async (testId: string) => {
  // The cast is unchecked and is safe ONLY because `toBeInstanceOf` runs immediately below —
  // that ordering is load-bearing, not incidental.
  const img = at(testId) as HTMLImageElement;
  // The placeholder testids differ from the img ones by a single path segment, so this is an
  // easy call to misaim; the docstring above measures what happens without this guard.
  expect(
    img,
    `${testId} is not an <img> — a placeholder id? pass the img id instead`
  ).toBeInstanceOf(HTMLImageElement);
  if (!img.complete) {
    await new Promise((resolve, reject) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', () => reject(new Error(`${testId}: fixture failed to load`)), {
        once: true,
      });
    });
  }
  // Before `decode()` so the failure names the testid — `decode()` itself rejects rather
  // than hangs, per the docstring's probe.
  expect(img.naturalWidth, `${testId}: fixture decoded to 0x0 — corrupt data URI?`).toBeGreaterThan(
    0
  );
  await img.decode();
  return img;
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
 *
 * 🔴 THROUGH `renderAtViewport`, WHICH VERIFIES THE VIEWPORT IT SET. This used to call
 * `page.viewport()` and render separately, never reading `window.innerWidth` back — the one
 * geometry file of eight that bypassed the harness's own floor. `renderAtViewport` throws when
 * the window disagrees with the request, and its docstring says why: a viewport call that
 * silently did nothing turns every assertion in the file into a claim about a different
 * screen. The desktop, tablet and ratio arms are exactly the ones that would not notice —
 * they measure the declared box, which is viewport-independent above 320px.
 */
const atWidth = async (width: number, ui: React.ReactElement) =>
  renderAtViewport(
    <div data-testid="page-container" style={{ width: '100%' }}>
      {ui}
    </div>,
    { width, height: 900 }
  );

/**
 * 🔴 ONE GUARDED LOOKUP. The expression was open-coded five times here, and the two copies
 * added most recently carried no existence check: a misaimed testid gave
 * `TypeError: Failed to execute 'getComputedStyle' … parameter 1 is not of type 'Element'`,
 * naming neither the id nor the assertion. This file now juggles eight ids that differ by a
 * suffix (`row-icon` / `row-icon-2` / `row-icon-placeholder` / `row-icon-placeholder-2`, and
 * the review four), which is exactly the misaim `settled`'s own comment warns about.
 */
const at = (testId: string) => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(el, `${testId} must be on screen`).not.toBeNull();
  return el!;
};

const box = (testId: string) => at(testId).getBoundingClientRect();

const container = () => box('page-container');

/**
 * 🔴 ASSERT THE CARD, NOT THE DOCUMENT — `documentElement.scrollWidth` CANNOT EXCEED ITS
 * CLIENT WIDTH IN THIS TIER.
 *
 * `globals.css` sets `html, body { overflow: hidden }`, so three "the page does not scroll
 * sideways" assertions in this file could never fail. Negative control: a planted
 * `<div style={{ width: 5000 }}>` inside the container left them all GREEN.
 *
 * It is not an academic gap. The no-cover overflow this suite was written to catch — a 320px
 * placeholder in a 246px column — is clipped by the Mantine Card's own `overflow-x: hidden`
 * and never reaches the document at all: measured, the placeholder sat at `right: 337` in a
 * 280px viewport while `documentElement.scrollWidth === clientWidth === 280`. So the document
 * check was blind to precisely the class of defect it was guarding.
 */
const noOverflowWithin = (testId: string) => {
  // 🔴 EVERY MATCH, NOT THE FIRST. `querySelector` returns the first element with the id, and
  // the arm that can actually overflow renders TWO cards — the no-cover one second. Checking
  // only the first measured the healthy card and passed with the defect live, which is how
  // this helper spent its first revision unable to fail.
  const els = Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`));
  expect(els.length, `${testId} must be on screen`).toBeGreaterThan(0);
  els.forEach((el, i) => {
    expect(
      el.scrollWidth,
      `${testId}[${i}] must not scroll sideways (content wider than its box)`
    ).toBeLessThanOrEqual(el.clientWidth + 1);
  });
};

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
    // The sharpest discriminator of the two tiers, and the one the other 7 geometry files
    // assert: `@tailwind utilities` is entirely absent from the `component` tier.
    expect(evidence.tailwindFlexUtilityResolves, 'Tailwind utilities must resolve').toBe(true);
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
    await settled('apps-review-listing-cover-gen-matrix');
    expect(
      iconEl.naturalWidth,
      'the fixture must NOT be square, or neither box can be discriminated'
    ).not.toBe(iconEl.naturalHeight);

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
    noOverflowWithin('apps-review-listing-media');
  });

  test('🔴 at phone width (280px) the cover CLAMPS to its container instead of widening the page', async () => {
    // ⚠️ Flex shrink, not `max-width`, is what narrows the cover IMG here — the per-branch
    // measurement is on `coverBoxStyle` in `ListingMediaThumb.tsx`. What this arm proves is
    // the shape under shrink, below.
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
    noOverflowWithin('apps-review-listing-media');

    // 🔴 AND THE RATIO SURVIVES THE SHRINK. This is the assertion this arm was missing: it
    // entered the one width regime where the box gives way and then said nothing about what
    // that does to the SHAPE. A fixed `height` does not follow a narrowed width, so the pair
    // gave 246x180 (1.37) here while this file's own subject promised 16:9. Red against a
    // fixed `height` (measured 1.37 vs 1.78), green against `aspect-ratio`.
    // 🔴 A LITERAL 16/9, NOT `REVIEW_COVER_W / REVIEW_COVER_H`. Production derives its
    // `aspect-ratio` from that same pair, so an expectation built from it stays green if both
    // constants move to a non-16:9 box — while this message still claims 16:9. The literal is
    // what the comment says and what the design asks for.
    expect(cover.width / cover.height, 'the clamped cover is still 16:9').toBeCloseTo(16 / 9, 1);
  });

  test('🔴 under the clamp a MISSING cover still matches a present one — parity is width-independent', async () => {
    // 🔴 A REGRESSION TEST, and an earlier draft of this comment mislabelled it an invariant
    // guard on the grounds that "parity held before the `aspect-ratio` change too". True of
    // the HEIGHT and false of the arm: it asserts WIDTH as well, and with `minWidth: 0`
    // removed it reds with `expected 320 to be close to 246`. It is the
    // regression test for the no-cover overflow, and calling it an invariant guard understated
    // its coverage and invited its deletion.
    // ONE render with two instances, not two renders: the render helper does not unmount
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

    // 🔴 THE CARD MUST NOT OVERFLOW, AND THIS GOES FIRST ON PURPOSE. The no-cover branch is
    // the only one that ever overflowed, so the arms rendering a cover PRESENT could never
    // prove it — and when the width assertions below ran first they killed the mutant before
    // this line executed, leaving it unreachable and therefore unproven. Ordered ahead of
    // them, removing `minWidth: 0` reds HERE, which is what shows the check can fail at all.
    // Measured with `minWidth: 0` removed: placeholder `right: 337` in a 280px viewport, while
    // `documentElement.scrollWidth` stayed 280 because the Card clips it.
    noOverflowWithin('apps-review-listing-media');

    // The clamp must actually be binding, or this asserts parity at a width where both are
    // simply their declared box — the vacuity the whole PHONE arm exists to avoid.
    expect(present.width, 'the clamp must be binding').toBeLessThan(REVIEW_COVER_W);
    expect(absent.width, 'same clamped width').toBeCloseTo(present.width, 0);
    expect(absent.height, 'same clamped height').toBeCloseTo(present.height, 0);
  });

  test('🔴 the ROW icon may not shrink, and the REVIEW icon must — the split that broke queue rows', async () => {
    // Asserted on the longhand rather than on a rendered row height. The rendered-height
    // version is what the tier used to catch and silently stopped catching, because it only
    // reproduces below the narrowest viewport any row-rendering geometry file uses (768).
    // A longhand assertion cannot stop reproducing.
    //
    // 🔴 BOTH ARMS, because one shared helper now serves both sizes: a single edit there
    // changes the row path and the review path together, so pinning one arm would let the
    // other move. Why each size gets the value it does is on `iconBoxStyle`.
    await atWidth(
      DESKTOP,
      <>
        <ListingIconThumb
          url={NON_SQUARE_IMAGE_DATA_URI}
          name="Row"
          imgTestId="row-icon"
          placeholderTestId="row-icon-placeholder"
        />
        <ListingIconThumb
          size="review"
          url={NON_SQUARE_IMAGE_DATA_URI}
          name="Review"
          imgTestId="review-icon"
          placeholderTestId="review-icon-placeholder"
        />
        <ListingIconThumb
          url={null}
          name="Row empty"
          imgTestId="row-icon-2"
          placeholderTestId="row-icon-placeholder-2"
        />
        <ListingIconThumb
          size="review"
          url={null}
          name="Review empty"
          imgTestId="review-icon-2"
          placeholderTestId="review-icon-placeholder-2"
        />
      </>
    );
    await settled('row-icon');

    // 🔴 THE WHOLE OBJECT, NOT JUST `shrink`. `flexLonghands` returns all three, and the one
    // other place that ASSERTS all three (`geometryHarness.geometry.test.tsx`) is also the
    // only one that needs to — `longhand`'s docstring in `test/geometry-setup.tsx` is where
    // the reason lives: a `flex` shorthand bug hides in the field you did not read. Measured:
    // with only `shrink` asserted, `grow 0→1` and `basis ${box}px→auto` both SURVIVED, so two
    // thirds of the shorthand this test exists to pin was unguarded.
    const flexOf = (testId: string) => flexLonghands(at(testId));

    // 🔴 LITERAL `basis`, NOT `${LISTING_ICON_BOX}px` — the same rule this file states for the
    // 16/9 ratio. Production derives the basis from those constants, so an expectation built
    // from them moves with any change to them: measured, `LISTING_ICON_BOX` 40→48 left the
    // whole tier green.
    //
    // ⚠️ THESE TWO PIN THE ICON CONSTANTS A SECOND TIME, deliberately: the constants case
    // further down pins the values, this one pins the rendered SHORTHAND, so a mutation to an
    // icon constant reds in both places.
    expect(flexOf('row-icon'), 'a queue-row icon must be rigid').toEqual({
      grow: '0',
      shrink: '0',
      basis: '40px',
    });
    expect(flexOf('review-icon'), 'the review icon must give way').toEqual({
      grow: '0',
      shrink: '1',
      basis: '96px',
    });
    // 🔴 THE REVIEW PLACEHOLDER IS THE ARM THAT ACTUALLY DIVERGED, and an earlier version of
    // this case asserted only the ROW one — which is `0` either way, so restoring the exact
    // shipped divergence (`flex: 0 0` pinned on the placeholder at both sizes) left the tier
    // the whole file GREEN. The comment named the defect and the fixture could not reach it: the
    // review arm above carries a url, so it paints an `img`, and no review-size PLACEHOLDER
    // was rendered at all. Both placeholders now, and the review one is the load-bearing half.
    // Against the IMG's own longhands rather than a restated literal: the claim is that the
    // two branches cannot diverge, so the img is the right expectation to compare to.
    expect(flexOf('row-icon-placeholder-2'), 'the row placeholder matches its img').toEqual(
      flexOf('row-icon')
    );
    expect(flexOf('review-icon-placeholder-2'), 'the review placeholder matches its img').toEqual(
      flexOf('review-icon')
    );

    // 🔴 AND `max-width`, WHICH IS NOT A FLEX LONGHAND AND SO RODE NONE OF THE ABOVE. It was
    // hand-written on the icon img and absent from the placeholder — measured at a 120px
    // container, img 86 against placeholder 96 — i.e. the pair diverged on a property outside
    // the shared object, under a comment claiming sharing had made divergence impossible. The
    // declaration lives in `iconBoxStyle` now; this is what holds it there. Measured: pulling
    // it back out leaves every other assertion in this file green.
    const maxWidthOf = (testId: string) => longhand(at(testId), 'max-width');
    // 🔴 A LITERAL ANCHOR FIRST. The two agreement assertions below cannot see a mutation
    // that moves BOTH sides: setting `maxWidth: 'none'` in the shared object (rather than
    // deleting it) leaves the whole tier green while removing the clamp this comment
    // calls load-bearing. Agreement proves they did not diverge; the literal proves what they
    // agree ON.
    // 🔴 ANCHORED ON THE PLACEHOLDERS, the strictly stronger choice: a `div` gets no
    // `max-width` from Tailwind preflight, so only `iconBoxStyle` can satisfy it. Anchoring an
    // IMG would miss a DELETION on THIS assertion (preflight keeps the img at `100%`), though
    // the agreement arm below catches one either way. Enumerated, there is no mutation the
    // placeholder anchor catches that (img anchor + agreement arm) misses — so this is message
    // quality, not coverage: it names the missing clamp rather than reporting a divergence.
    expect(maxWidthOf('row-icon-placeholder-2'), 'the row clamp really exists').toBe('100%');
    expect(maxWidthOf('row-icon-placeholder-2'), 'the row pair agrees on max-width').toBe(
      maxWidthOf('row-icon')
    );
    // Both halves need an anchor: with only the row one, `maxWidth: size === 'review' ?
    // 'none' : '100%'` left the whole tier green — the same class, half-closed.
    expect(maxWidthOf('review-icon-placeholder-2'), 'the review clamp really exists').toBe('100%');
    expect(maxWidthOf('review-icon-placeholder-2'), 'the review pair agrees on max-width').toBe(
      maxWidthOf('review-icon')
    );
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
    // 16/9 as a literal, not `LISTING_COVER_W / LISTING_COVER_H` — that is the ROW pair, and
    // this arm renders the REVIEW cover. It passed only because both pairs are 16:9.
    expect(cover.width / cover.height).toBeCloseTo(16 / 9, 1);
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

  test('🔴 the six box constants are the numbers this page was designed around', () => {
    // 🔴 THE ONLY PIN ON FOUR OF THESE SIX. Every other assertion in this file compares a
    // rendered box to the constant it was rendered FROM, so they move together when a constant
    // moves — blind to exactly the change that matters. Measured: either COVER pair can be
    // changed (96→120 with 54→67, or 320→400 with 180→225) and ONLY this case reds. The two
    // ICON constants are also pinned by the `basis` literals further up, so a mutation there
    // reds twice; that overlap is worth keeping, since one pins the constant and the other
    // pins the rendered shorthand.
    //
    // A box size is a product decision — a 40px row icon keeps a queue scannable; a 320px
    // review cover is big enough to judge publisher art by — so it should cost a deliberate
    // edit here rather than riding along with a refactor.
    expect({ LISTING_ICON_BOX, LISTING_COVER_W, LISTING_COVER_H }, 'the queue-row boxes').toEqual({
      LISTING_ICON_BOX: 40,
      LISTING_COVER_W: 96,
      LISTING_COVER_H: 54,
    });
    expect({ REVIEW_ICON_BOX, REVIEW_COVER_W, REVIEW_COVER_H }, 'the review-page boxes').toEqual({
      REVIEW_ICON_BOX: 96,
      REVIEW_COVER_W: 320,
      REVIEW_COVER_H: 180,
    });
    // 🔴 THESE TWO LOOK VACUOUS AND ARE NOT — I cut them once on that reading and had to put
    // them back. They sit downstream of `toEqual`s that pin all six values, so no PRODUCTION
    // mutation can reach them with the test still running. What they guard is the test's own
    // literals: change a constant AND re-pin its literal to match, and these red. Measured —
    // `LISTING_COVER_H` 54→72 in both places gives `expected 1.333… to be close to 1.777…`.
    // That is the review someone does when a box "needs to be taller", and it is exactly the
    // edit that would silently make a cover non-16:9 while every other arm stayed green — and
    // a non-16:9 box turns `object-fit: cover` from a crop into a squash.
    expect(LISTING_COVER_W / LISTING_COVER_H).toBeCloseTo(16 / 9, 1);
    expect(REVIEW_COVER_W / REVIEW_COVER_H).toBeCloseTo(16 / 9, 1);
  });
});

/**
 * ⚠️ THE REVIEW GALLERY IS A CONSTANT ONE COLUMN, NOT A BREAKPOINTED PAIR, and that is the
 * choice worth recording: `lg` is 1200px on the MANTINE scale this prop resolves against
 * (1184 is the Tailwind one; `chromeGeometry.ts` documents that collision by name), so
 * breaking there would give two columns at 1280 —
 * identical to the modal's, i.e. invisible at exactly the width this page is used at. It has
 * never had a breakpoint; an earlier draft of this paragraph said "the gallery's breakpoint
 * was chosen so…", which described a declaration that does not exist.
 */
describe('the bundle screenshots are bigger on the review page than in the modal', () => {
  /** The grid Mantine rendered, and the column count it DECLARED. */
  const declaredCols = () => {
    const grid = at('apps-review-screenshot-0').closest('div')!.parentElement!;
    // 🔴 THE NON-EMPTY CHECK LIVES HERE, NOT AT A CALL SITE. `--sg-cols` is a custom
    // property, so an unset one reads as `''` — and `''` satisfies the NEGATIVE control
    // (`not.toBe('1')`), which is a different test from the positive one. Guarding at the
    // positive call site covered the arm that `toBe('1')` already protected and left the
    // control failing open. In the helper, all three call sites get it.
    const cols = longhand(grid, '--sg-cols');
    expect(cols, '--sg-cols must be set at all').not.toBe('');
    return cols;
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
      noOverflowWithin('page-container');
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
