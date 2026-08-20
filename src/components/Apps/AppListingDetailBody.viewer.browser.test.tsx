import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type * as TrpcMod from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type { ListingDetail } from '~/server/schema/blocks/app-listing-read.schema';

/**
 * App-listing detail — the SCREENSHOT VIEWER (click a tile → full-size modal with
 * prev/next, Esc, caption and a `3 / 7` position indicator).
 *
 * 🔴 READ THIS BEFORE TREATING ANY RESULT HERE AS A GATE: IT IS NOT ONE. This file
 * is in the Vitest browser-mode `component` project, which CI runs only as the
 * preview pipeline's `preview / component-tests` — report-only, non-blocking, and
 * not reported at all when the preview build fails. The gating half of this change
 * is `__tests__/appListingScreenshotNav.test.ts`, in the blocking node project,
 * which pins the INDEX ARITHMETIC (open on N, step by one, stop at the ends, skip
 * broken, count only what is reachable). That file cannot see a single DOM node;
 * this one cannot block a merge. Both claims are needed; neither substitutes for the
 * other, and this file exists for the half the pure functions structurally cannot
 * make: that the component actually CALLS them, that the tile hands them the index it
 * represents, that the arrow labelled "Next" is wired to `+1`, and that the a11y
 * contract (focus in, focus back, Esc, `aria-modal`) really holds in a browser.
 *
 * 🔴 RED/GREEN HONESTY. Every test below is NEW-FEATURE coverage, not regression
 * coverage. At `origin/main` `AppListingScreenshotViewer` does not exist and the
 * tiles are not buttons, so this file does not fail an assertion there — it fails to
 * find a tile at all. That is a much weaker statement than "red at base", and it is
 * labelled as such rather than counted as a regression guard. The one thing that IS
 * regression-shaped is the untouched sibling suite: `AppListingDetailBody.gallery.
 * browser.test.tsx` (7 tests) and `AppListingDetailBody.browser.test.tsx` (64) both
 * pass unchanged, which is what says the tile-becomes-a-button change did not move
 * the grid geometry or the page structure.
 *
 * 🔴 NO CSS IS LOADED (`vitest.config.mts` registers only the process shim and
 * `test/component-setup`), so nothing here measures a visual property. Every
 * assertion is structural: an element's role, its accessible name, a `data-testid`,
 * `document.activeElement`, an attribute. The sibling gallery suite is the one file
 * that loads a stylesheet, and it does so because its claims are geometry.
 *
 * 🔴 FIXTURES ARE PAIRWISE DISTINCT BY CONSTRUCTION. Every screenshot carries a
 * caption naming its own index (`Shot one` … `Shot seven`) and a URL that differs in
 * one encoded byte, so "the viewer opened on the wrong shot" is a different string
 * rather than an identical-looking one. A fixture whose captions repeat, or whose
 * URLs are all the same data URI, cannot see an off-by-one at all — it is the single
 * likeliest way this file would go vacuously green.
 */

const WIDE: [number, number] = [1440, 900];

// Anonymous viewer, so the `⋮` menu and its modals never mount — nothing here is
// about them, and each is a portal that would sit beside the viewer's own portal.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

// 🔴 `importOriginal` SPREAD, not a wholesale replacement (local-rules/
// no-wholesale-module-mock): a hand-written factory silently breaks every importer
// the day the real module grows an export it omits — and in this project that
// surfaces as `Tests no tests`, i.e. as nothing to see rather than as a failure.
vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocks: true, appListings: true, appBlocksPages: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: {
    appListings: {
      listAvailable: { useQuery: () => ({ data: { items: [] }, isLoading: false }) },
      getMyReview: { useQuery: () => ({ data: null, isLoading: false }) },
      upsertReview: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      reportListing: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    user: {
      getCreator: { useQuery: () => ({ data: null }) },
      getById: { useQuery: () => ({ data: undefined, isInitialLoading: false }) },
    },
    useUtils: () => ({
      appListings: {
        getMyReview: { invalidate: async () => undefined },
        listReviews: { invalidate: async () => undefined },
        getAppDetail: { invalidate: async () => undefined },
      },
    }),
  },
}));
vi.mock('~/components/Apps/AppListingReviews', () => ({
  AppListingReviews: () => <div data-testid="mock-reviews" />,
}));
vi.mock('~/components/Apps/AppListingComments', () => ({
  AppListingComments: () => <div data-testid="mock-comments" />,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppListingDetailBody } = await import('./AppListingDetailBody');

beforeEach(async () => {
  await page.viewport(...WIDE);
});

/**
 * A screenshot URL that RESOLVES, and that is DIFFERENT for every index.
 *
 * The SVG carries the index in an attribute, so each shot's `src` is a distinct
 * string while every one of them still decodes to a real image. Both halves matter:
 * a shared data URI would make "showing the wrong shot" indistinguishable from
 * "showing the right one", and an http(s) URL would not load at all (see
 * `LOADABLE_IMAGE_DATA_URI`'s header in `test/component-setup`).
 */
const okShot = (n: number) =>
  `data:image/svg+xml;base64,${btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" data-n="${n}"/>`
  )}`;

/** A URL that cannot resolve, so the browser fires `error` and the shot goes broken. */
const brokenShot = (n: number) => `https://cdn.invalid.example/missing-${n}.png`;

const CAPTIONS = ['Shot one', 'Shot two', 'Shot three', 'Shot four', 'Shot five'];

/** `n` loadable screenshots, each with its own caption and its own URL. */
const okShots = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    url: okShot(i),
    caption: CAPTIONS[i] ?? `Shot ${i + 1}`,
  }));

function base(over: Partial<ListingDetail>): ListingDetail {
  return {
    id: 'l1',
    serialId: 1,
    slug: 'my-app',
    kind: 'onsite',
    collaborators: [],
    name: 'My App',
    tagline: 'A handy app',
    description: null,
    category: 'utility',
    contentRating: null,
    iconUrl: null,
    coverUrl: null,
    // `null` deliberately — a creator mounts `SmartCreatorCard`, a live tRPC surface
    // with its own child graph, none of which this file is about.
    creator: null,
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
    installCount: 4213,
    updatedAt: '2026-03-04T05:06:07.000Z',
    screenshots: [],
    kindData: {
      kind: 'onsite',
      appBlockId: 'blk-1',
      hasPage: true,
      liveUrl: 'https://my-app.civit.ai',
    },
    ...over,
  };
}

async function renderBody(detail: ListingDetail) {
  const { container } = await renderWithProviders(<AppListingDetailBody detail={detail} />);
  const within = page.elementLocator(container);
  await expect.element(within.getByText('My App')).toBeInTheDocument();
  return { container, within };
}

/**
 * The tiles CURRENTLY rendered, in document order.
 *
 * 🔴 Read live from the DOM on every call rather than captured once: a tile removes
 * itself when its image 404s, so a list captured before that settles is a list of
 * elements some of which are no longer in the document.
 */
const tiles = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="apps-listing-screenshot-tile"]')
  );

/** The viewer's modal, or null when it is closed. It renders in a PORTAL, not in `container`. */
const viewer = () => document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');

/** The `<img>` the viewer is displaying, read from the document (portal again). */
const viewerImage = () =>
  document.querySelector<HTMLImageElement>('[data-testid="apps-listing-screenshot-viewer-image"]');

const viewerPositionText = () =>
  document
    .querySelector('[data-testid="apps-listing-screenshot-position"]')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim() ?? null;

const viewerCaptionText = () =>
  document.querySelector('[data-testid="apps-listing-screenshot-caption"]')?.textContent ?? null;

/** Wait until the viewer is showing the shot at `index` — asserted by its `src`. */
async function expectShowing(index: number) {
  await vi.waitFor(() => {
    const img = viewerImage();
    expect(img, `no viewer image while expecting shot ${index}`).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(okShot(index));
  });
}

const prevButton = () => page.getByRole('button', { name: 'Previous screenshot' });
const nextButton = () => page.getByRole('button', { name: 'Next screenshot' });

describe('screenshot viewer — opening', () => {
  /**
   * 🔴 THE HEADLINE: THE TILE OPENS ITS OWN SHOT, NOT THE FIRST ONE.
   *
   * Tile 2 (the third) is chosen rather than tile 1, because index 1 is where an
   * off-by-one and a correct answer can coincide: `0 + 1` and `1` are both plausible
   * and only one of the two arrows distinguishes them. From index 2 the four
   * candidate mutants — always-0, index±1, and the mirrored `count - index - 1`
   * (which is 2 for a 5-shot list, so the fixture is FIVE long and the tile is the
   * THIRD, giving `5 - 2 - 1 = 2`… deliberately equal, and therefore excluded by the
   * SECOND assertion below, which opens tile 3 where the mirror gives 1).
   */
  test('clicking tile N opens the viewer on shot N', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    expect(tiles(container)).toHaveLength(5);

    await userEvent.click(tiles(container)[2]);
    await expectShowing(2);
    expect(viewerCaptionText()).toBe('Shot three');
    expect(viewerPositionText()).toBe('3 / 5');
  });

  /**
   * A SECOND opening point, on a different tile of the same listing, so no single
   * arithmetic coincidence can satisfy both. (Together with the case above this is
   * the two-measured-points rule: `2 → 2` and `3 → 3` share no wrong formula.)
   */
  test('a different tile opens a different shot — two measured points', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));

    await userEvent.click(tiles(container)[3]);
    await expectShowing(3);
    expect(viewerCaptionText()).toBe('Shot four');
    expect(viewerPositionText()).toBe('4 / 5');
  });

  test('the first tile opens the first shot', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));

    await userEvent.click(tiles(container)[0]);
    await expectShowing(0);
    expect(viewerPositionText()).toBe('1 / 5');
  });

  /** Nothing is open before a click — so every assertion above is about the click. */
  test('the viewer is closed until a tile is activated', async () => {
    await renderBody(base({ screenshots: okShots(5) }));
    expect(viewer()).toBeNull();
    expect(viewerImage()).toBeNull();
  });
});

describe('screenshot viewer — navigation', () => {
  test('next advances by exactly one, and prev goes back by exactly one', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[1]);
    await expectShowing(1);

    await nextButton().click();
    await expectShowing(2);
    expect(viewerPositionText()).toBe('3 / 5');
    expect(viewerCaptionText()).toBe('Shot three');

    await nextButton().click();
    await expectShowing(3);
    expect(viewerPositionText()).toBe('4 / 5');

    await prevButton().click();
    await expectShowing(2);
    expect(viewerPositionText()).toBe('3 / 5');
  });

  /**
   * 🔴 THE BOUNDARY RULE IS **STOP, NOT WRAP** — decided in
   * `appListingScreenshotNav.ts` and rendered as a DISABLED control, so the viewer
   * never offers a move it will not make. Both ends are measured; one end alone
   * cannot tell "stops at the last" from "stops everywhere".
   */
  test('at the LAST shot, next is disabled and prev still works', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[4]);
    await expectShowing(4);
    expect(viewerPositionText()).toBe('5 / 5');

    await expect.element(nextButton()).toBeDisabled();
    await expect.element(prevButton()).toBeEnabled();

    // …and pressing the key the disabled control mirrors does not wrap either.
    await userEvent.keyboard('{ArrowRight}');
    await expectShowing(4);
  });

  test('at the FIRST shot, prev is disabled and next still works', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[0]);
    await expectShowing(0);

    await expect.element(prevButton()).toBeDisabled();
    await expect.element(nextButton()).toBeEnabled();

    await userEvent.keyboard('{ArrowLeft}');
    await expectShowing(0);
  });

  /**
   * 🔴 ARROW KEYS, AND THE DIRECTIONS ARE ASSERTED SEPARATELY. A single "arrows
   * navigate" test is satisfied by a swapped pair; landing on 3 after Right and back
   * on 2 after Left is not.
   */
  test('ArrowRight and ArrowLeft move the viewer in their own directions', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[2]);
    await expectShowing(2);

    await userEvent.keyboard('{ArrowRight}');
    await expectShowing(3);
    expect(viewerPositionText()).toBe('4 / 5');

    await userEvent.keyboard('{ArrowLeft}');
    await expectShowing(2);

    await userEvent.keyboard('{ArrowLeft}');
    await expectShowing(1);
    expect(viewerPositionText()).toBe('2 / 5');
  });

  /**
   * A one-screenshot listing offers NO navigation. It is still a viewer — it opens,
   * shows the shot, its caption and `1 / 1` — but both controls are dead, which is
   * the honest rendering of "there is nothing either way".
   */
  test('a listing with exactly ONE screenshot offers no navigation', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(1) }));
    expect(tiles(container)).toHaveLength(1);

    await userEvent.click(tiles(container)[0]);
    await expectShowing(0);
    expect(viewerPositionText()).toBe('1 / 1');
    expect(viewerCaptionText()).toBe('Shot one');

    await expect.element(prevButton()).toBeDisabled();
    await expect.element(nextButton()).toBeDisabled();

    // Neither key moves it, and neither closes it.
    await userEvent.keyboard('{ArrowRight}');
    await userEvent.keyboard('{ArrowLeft}');
    await expectShowing(0);
  });

  /**
   * 🔴 ZERO SCREENSHOTS — there is no gallery at all, so there is nothing to open and
   * no viewer mounted. This is the invariant the existing gallery suite also pins
   * (the section is hidden), restated here as "and therefore no dialog exists": a
   * viewer that mounted for an empty listing would be an empty modal one stray key
   * away.
   */
  test('a listing with ZERO screenshots renders no gallery and no viewer', async () => {
    const { container, within } = await renderBody(base({ screenshots: [] }));
    expect(container.querySelectorAll('[data-testid="apps-listing-screenshot-grid"]')).toHaveLength(
      0
    );
    expect(tiles(container)).toHaveLength(0);
    expect(within.getByText('Screenshots').elements()).toHaveLength(0);
    expect(viewer()).toBeNull();

    // The arrow keys are bound only while the viewer is open, so they must be inert
    // here — a global binding would fight the page behind it.
    await userEvent.keyboard('{ArrowRight}');
    expect(viewer()).toBeNull();
  });
});

describe('screenshot viewer — closing', () => {
  test('Escape closes the viewer', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[2]);
    await expectShowing(2);

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(viewer()).toBeNull());
  });

  test('the close button closes the viewer', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[1]);
    await expectShowing(1);

    await page.getByRole('button', { name: 'Close screenshot viewer' }).click();
    await vi.waitFor(() => expect(viewer()).toBeNull());
  });
});

describe('screenshot viewer — accessibility', () => {
  /**
   * 🔴 THE TILE IS A REAL BUTTON, ASSERTED STRUCTURALLY. `role="button"` on the
   * ELEMENT (not a `getByRole` query that a `role` attribute on a `<div>` would also
   * satisfy) plus the tag name, because "keyboard-activatable" is a property of the
   * element the browser gives you for free, and of nothing else.
   */
  test('each tile is a keyboard-activatable <button> with the caption in its name', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(3) }));
    const all = tiles(container);
    expect(all).toHaveLength(3);
    for (const tile of all) expect(tile.tagName).toBe('BUTTON');

    // The accessible name is COMPUTED FROM CONTENT (image alt + caption), never an
    // aria-label that would strip the visible caption (WCAG 2.5.3).
    const third = all[2];
    expect(third.textContent).toContain('Shot three');
    expect(third.querySelector('img')?.getAttribute('alt')).toBe('Shot three');
  });

  test('a tile opens the viewer from the keyboard alone', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    const tile = tiles(container)[3];

    tile.focus();
    expect(document.activeElement).toBe(tile);
    await userEvent.keyboard('{Enter}');

    await expectShowing(3);
  });

  /** The dialog is labelled and marked modal — the two things a screen reader needs. */
  test('the dialog is modal and carries an accessible name', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[0]);
    await expectShowing(0);

    const dialog = viewer();
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');

    // `aria-labelledby` must resolve to real text, not merely be present — a label
    // pointing at a missing id is worse than no label.
    const labelledBy = dialog!.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('My App screenshots');
  });

  test('focus moves INTO the dialog when it opens', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    await userEvent.click(tiles(container)[1]);
    await expectShowing(1);

    const dialog = viewer()!;
    await vi.waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(dialog.contains(document.activeElement)).toBe(true);
    });
  });

  /**
   * 🔴 FOCUS RETURNS TO THE TILE THAT OPENED IT — to that tile, not to "some tile".
   * The listing has five, and the one opened is the fourth, so a restore that
   * defaulted to the first or to the gallery container fails here.
   */
  test('focus returns to the ORIGINATING tile on close', async () => {
    const { container } = await renderBody(base({ screenshots: okShots(5) }));
    const opener = tiles(container)[3];

    await userEvent.click(opener);
    await expectShowing(3);
    // Control: focus really did leave the tile, so the assertion after the close is
    // about a restore and not about focus that never moved.
    await vi.waitFor(() => expect(document.activeElement).not.toBe(opener));

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(viewer()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});

describe('screenshot viewer — broken screenshots', () => {
  /**
   * 🔴 THE INDEX-SPACE TEST, AND THE ONE THIS FEATURE IS MOST LIKELY TO GET WRONG.
   *
   * Five screenshots go in; the FIRST one 404s, so the grid ends up with four tiles.
   * The tile a viewer now sees third is shot index 3, NOT index 2 — and the viewer
   * must open on 3. A viewer keyed on the tile's POSITION in the rendered grid would
   * open on shot 2 here, and would be indistinguishable from correct on any listing
   * with no broken art, which is every listing anyone checks by hand.
   *
   * 🔴 THE BROKEN SHOT IS THE **FIRST** ONE, AND THAT IS A CORRECTION, NOT A STYLE
   * CHOICE. This test originally broke shot index 1, and MEASURED AS VACUOUS: the
   * renumbering mutant (grid position used as the viewer index) SURVIVED it. With
   * shot 1 broken, a renumbered click on the second visible tile resolves to index 1
   * — which is the broken shot — so the viewer's own rescue effect skipped forward to
   * index 2 and produced the correct answer for the wrong reason. Breaking shot 0
   * shifts every later index by one onto a VIABLE shot, so the rescue cannot launder
   * the mistake and the mutant dies. Do not "simplify" the fixture back.
   *
   * The `data-screenshot-index` assertion is the direct form of the same claim: the
   * tile states which shot it represents, and under the renumbering mutant it states
   * `2` where the correct value is `3`. The `alt` list is the positive control that
   * the first tile really rendered and then removed itself — `Shot one` is present in
   * the fixture and absent from the DOM.
   */
  test('a broken screenshot does not shift the index the surviving tiles open', async () => {
    const shots = okShots(5);
    shots[0] = { url: brokenShot(0), caption: 'Shot one' };
    const { container } = await renderBody(base({ screenshots: shots }));

    await vi.waitFor(() => expect(tiles(container)).toHaveLength(4));
    expect(tiles(container).map((t) => t.querySelector('img')?.getAttribute('alt'))).toEqual([
      'Shot two',
      'Shot three',
      'Shot four',
      'Shot five',
    ]);

    // The tile now THIRD in the grid represents shot index 3 — as a DOM fact…
    expect(tiles(container).map((t) => t.dataset.screenshotIndex)).toEqual(['1', '2', '3', '4']);
    // …and as behaviour.
    await userEvent.click(tiles(container)[2]);
    await expectShowing(3);
    expect(viewerCaptionText()).toBe('Shot four');
  });

  /**
   * 🔴 AND THE COUNTER COUNTS WHAT NAVIGATION CAN REACH. With one of five broken the
   * indicator reads `3 / 4`, not `4 / 5`: a total that included the broken shot would
   * promise a screenshot prev/next can never land on. The broken shot is the first
   * one for the same reason as the test above — see its header.
   */
  test('the position indicator excludes broken screenshots from BOTH numbers', async () => {
    const shots = okShots(5);
    shots[0] = { url: brokenShot(0), caption: 'Shot one' };
    const { container } = await renderBody(base({ screenshots: shots }));
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(4));

    await userEvent.click(tiles(container)[2]); // shot index 3, viable position 3
    await expectShowing(3);
    expect(viewerPositionText()).toBe('3 / 4');
  });

  /**
   * 🔴 NAVIGATION SKIPS THE BROKEN SHOT RATHER THAN LANDING ON IT. Shot 1 is broken,
   * so stepping back from shot 2 must reach shot 0 — a TWO-place move that a "step
   * by one" implementation cannot produce, and that a "skip exactly one broken" and a
   * "skip until viable" implementation agree on… which is why the second half of this
   * test uses a RUN of two broken shots, where they disagree.
   */
  test('prev/next skip over broken screenshots, including a run of them', async () => {
    const shots = okShots(5);
    shots[1] = { url: brokenShot(1), caption: 'Shot two' };
    const { container } = await renderBody(base({ screenshots: shots }));
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(4));

    await userEvent.click(tiles(container)[1]); // shot 2
    await expectShowing(2);
    await prevButton().click();
    await expectShowing(0); // skipped 1
    expect(viewerPositionText()).toBe('1 / 4');
    // Forward again lands back on 2, not on the broken 1.
    await nextButton().click();
    await expectShowing(2);

    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(viewer()).toBeNull());
  });

  test('a RUN of broken screenshots is skipped in one move', async () => {
    const shots = okShots(5);
    shots[1] = { url: brokenShot(1), caption: 'Shot two' };
    shots[2] = { url: brokenShot(2), caption: 'Shot three' };
    const { container } = await renderBody(base({ screenshots: shots }));
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(3));

    await userEvent.click(tiles(container)[0]); // shot 0
    await expectShowing(0);
    expect(viewerPositionText()).toBe('1 / 3');

    await nextButton().click();
    await expectShowing(3); // skipped BOTH 1 and 2
    expect(viewerPositionText()).toBe('2 / 3');
  });

  /**
   * 🔴 A TRAILING RUN OF BROKEN SHOTS MEANS THE LAST VIABLE SHOT REALLY IS THE END —
   * and this is the ONE browser case that can see a navigation which does not skip.
   *
   * MEASURED, not assumed. A mutant replacing the skip loop with a bare `index ± 1`
   * SURVIVED every other broken-shot test in this file, because the viewer's own
   * rescue effect moves off the broken index it lands on and arrives at the same
   * answer by a different route. The rescue cannot launder THIS case: with 3 and 4
   * broken, correct code reports "nothing after shot 2" and DISABLES the control,
   * while the unskipping mutant offers shot 3 and leaves it enabled. A disabled
   * button is a state no rescue can reach after the fact.
   *
   * (The same mutant is also killed outright in the blocking node project — see
   * `appListingScreenshotNav.test.ts`. This is the browser half of that claim.)
   *
   * 🔴 THE FIXTURE IS TWO SHOTS, AND THAT IS A MEASURED CONSTRAINT RATHER THAN
   * MINIMALISM. Two earlier drafts — five shots with the last two broken, then three
   * with the last one broken — each PASSED IN ISOLATION AND FAILED IN THE FULL-FILE
   * RUN, on the tile count: the broken tile never fired `error`, because tiles are
   * `loading="lazy"` and a tile below the first grid row is only FETCHED when Chrome's
   * distance-from-viewport heuristic says so — which is not a constant, and which
   * earlier tests in the file can move (a Mantine `Modal` locks body scroll while it
   * is open). Substituting a fresh URL ruled out negative caching; the row did. That
   * lazy behaviour is real page behaviour, and it is exactly why the viewer carries a
   * rescue effect — but it makes any below-the-fold dangling URL a non-deterministic
   * fixture. **Every broken-shot fixture in this file keeps its dangling URL in the
   * first grid row**, which for a two-track grid means index 0 or 1.
   *
   * The lost "the other direction is still live" control lives at suite level instead:
   * `at the FIRST shot, prev is disabled and next still works` shows the same viewer
   * rendering an ENABLED next from index 0 when nothing is broken, so the disabled
   * assertion below is about the trailing broken shot and not about a dead control.
   */
  test('a TRAILING run of broken screenshots ends the navigation', async () => {
    const shots = okShots(2);
    shots[1] = { url: brokenShot(92), caption: 'Shot two' };
    const { container } = await renderBody(base({ screenshots: shots }));
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(1));

    await userEvent.click(tiles(container)[0]); // shot 0 — the ONLY viable one
    await expectShowing(0);
    expect(viewerPositionText()).toBe('1 / 1');

    // 🔴 The listing HAS a second screenshot; it just cannot be shown. So the control
    // that would carry the viewer to it must be dead — an enabled "Next" here is an
    // offer to navigate onto a blank frame.
    await expect.element(nextButton()).toBeDisabled();

    // …and the key mirrors the control rather than reaching the broken shot.
    await userEvent.keyboard('{ArrowRight}');
    await expectShowing(0);
  });

  /**
   * 🔴 A LISTING WHOSE SCREENSHOTS ALL 404 LOSES ITS GRID BUT KEEPS ITS SECTION —
   * exactly the pre-existing behaviour (the tiles hide themselves; the `Screenshots`
   * heading stays) — and, the new part, there is still no dialog to open.
   */
  test('every screenshot broken — no tiles remain and nothing can be opened', async () => {
    const { container } = await renderBody(
      base({
        screenshots: [
          { url: brokenShot(1), caption: 'Shot one' },
          { url: brokenShot(2), caption: 'Shot two' },
        ],
      })
    );
    await vi.waitFor(() => expect(tiles(container)).toHaveLength(0));
    expect(viewer()).toBeNull();
    await userEvent.keyboard('{ArrowRight}');
    expect(viewer()).toBeNull();
  });
});
