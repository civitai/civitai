import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Raw text, NOT a stylesheet import — the ledger's REAL rules are parsed out of
// this and injected. See `ledgerFromGlobals` for why that indirection exists.
import globalsCss from '~/styles/globals.css?raw';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * ULTRAWIDE — a full-page App Block must stop growing, MEASURED.
 *
 * THE DEFECT. Nothing in the run page's chain bounded the app's width: the page
 * wrapper is `width: '100%'`, the host root was `width: '100%'`, and the iframe
 * is `width: '100%'`. On a 2560px monitor an app therefore rendered as a single
 * ~2500px column. The apps cannot fix this themselves — an App Block is a
 * cross-origin guest that is handed a viewport and told nothing about the
 * display — so the cap lives on the host.
 *
 * 🔴 THIS FILE IMPORTS NOTHING NEW FROM THE HOST, ON PURPOSE.
 *
 * The obvious spelling — import `APP_PAGE_MAX_WIDTH_PX` and assert the rendered
 * width equals it — is the self-referential trap `FILL_MIN_HEIGHT_PX` already
 * recorded: it compares a measurement against the very constant that produced
 * it, so it is true by construction for every value including a broken one. It
 * has a second cost here that matters more: a file that imports a symbol which
 * does not exist on the base revision fails to COLLECT, and a collection failure
 * reports "no tests" rather than a red assertion — which is indistinguishable
 * from a suite wired to nothing. Every expectation below is either a LITERAL
 * bound or a comparison between two things measured in the same render, so this
 * exact file runs on `origin/main` and fails there for the right reason.
 *
 * 🔴 EVERY VIEWPORT IS SET EXPLICITLY AND NAMED IN THE ASSERTION. The runner's
 * default is 414px WIDE — narrower than a phone in landscape — so a width claim
 * written without `page.viewport(...)` is not merely under-tested, it is
 * measuring a viewport at which this feature is INERT and would pass whether or
 * not the fix exists. (`AppsPageLayout.geometry.browser.test.tsx` pins 1440x900
 * for the same reason: the harness fixes no viewport of its own, so any suite
 * that cares about width has to state one.)
 *
 * NOTE ON REACH: the browser `component` project runs in CI as the
 * `preview / component-tests` status — REPORT-ONLY, so a break here is visible
 * but does not block a merge. This file is the EMPIRICAL half; the source-guard
 * half is `__tests__/pageBlockHostMaxWidth.test.ts`, which is in the node `unit`
 * project — report-only on a pull request too (`continue-on-error`), and an
 * honest verdict on a push to `main` or a `workflow_dispatch`. NEITHER TIER
 * BLOCKS A MERGE: `main` requires no status check at all in this repo. Neither
 * can replace the other either: only a real layout can see a width, and only the
 * node tier stays honest on `main`.
 */

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  // FeatureFlagsProvider (in PageBlockHost's real render graph) statically
  // imports `setTrpcBatchingEnabled`; the spread keeps every other real export
  // so a new one can't silently arrive as `undefined` and take the whole file
  // down to "0 tests collected".
  setTrpcBatchingEnabled: vi.fn(),
  trpc: {
    // Collection follow/unfollow host bridge (SET_COLLECTION_FOLLOW). Both
    // hosts register the handler, so every host-rendering suite needs these
    // two session-authed mutations present on the mocked client.
    collection: {
      follow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      unfollow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    generation: { resolveWildcardPack: { useMutation: () => ({ mutateAsync: vi.fn() }) } },
    blocks: {
      submitWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzBalance: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyViewer: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzTransactions: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyBuzzAccounts: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getMyDailyCompensation: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      estimateWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      pollWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      queryAppWorkflows: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      cancelAppWorkflow: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      publishGenerationOutputs: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      getImagesByIds: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    apps: {
      shared: {
        append: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        update: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        vote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        unvote: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        withdraw: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        report: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
      storage: {
        set: { useMutation: () => ({ mutateAsync: vi.fn() }) },
        delete: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      },
    },
    useUtils: () => ({
      apps: {
        shared: {
          list: { fetch: vi.fn() },
          getCount: { fetch: vi.fn() },
          getCounts: { fetch: vi.fn() },
          get: { fetch: vi.fn() },
        },
        storage: {
          get: { fetch: vi.fn() },
          list: { fetch: vi.fn() },
          getQuota: { fetch: vi.fn() },
        },
      },
    }),
  },
}));

// eslint-disable-next-line import/first
import { PageBlockHost } from '~/components/AppBlocks/PageBlockHost';

const SAME_ORIGIN_SRC = `${window.location.origin}/`;

/** The app slug the fixture runs as — also the key an opt-out rule is written against. */
const BLOCK_ID = 'max-width-app';

const baseProps = {
  appBlockId: 'apb_maxwidth',
  blockId: BLOCK_ID,
  appId: 'app_maxwidth',
  blockInstanceId: 'page_apb_maxwidth',
  appName: 'Max Width App',
  iframeSrc: SAME_ORIGIN_SRC,
  surface: 'page-run' as const,
  // Required. These suites cover the DEFAULT (host-veil) presentation;
  // the bootSkeleton path is covered in PageBlockHostLaunchReveal.
  bootSkeleton: false,
  sandbox: 'allow-scripts',
  trustTier: 'internal' as const,
  slug: BLOCK_ID,
  token: 'tok_maxwidth',
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  declaredScopes: [] as string[],
  missingScopes: [] as string[],
  needsConsent: false,
  tokenError: false,
  viewer: null,
  theme: 'light' as const,
};

/**
 * Stylesheet injected by a test, removed after it.
 *
 * Without the teardown a `:root` override written by one test survives into the
 * next one in this file (browser mode gives each FILE an iframe, not each test),
 * which would silently re-point the cap for every case after it.
 */
let injected: HTMLStyleElement | null = null;
function injectCss(css: string) {
  injected = document.createElement('style');
  injected.textContent = css;
  document.head.appendChild(injected);
}
afterEach(() => {
  injected?.remove();
  injected = null;
});

/**
 * The REAL full-bleed opt-out rules, parsed out of `globals.css` itself.
 *
 * 🔴 WHY THIS INDIRECTION EXISTS RATHER THAN JUST LOADING THE STYLESHEET. The
 * component harness deliberately does NOT load the app cascade — `component-
 * setup.tsx` extracts only the `:root` custom properties, because importing
 * `globals.css` pulls Tailwind preflight and Mantine layer ordering and changes
 * the rendered geometry of every existing test. So the ledger's rules are simply
 * ABSENT here by default, and a test that wrote its own copy of the rule would be
 * asserting against a fixture rather than against the ledger: deleting the real
 * entry, or mistyping its selector, would leave that test green.
 *
 * Taking the rules from the file and injecting ONLY those keeps the cascade the
 * suite has always had while making the assertions depend on the shipped text.
 *
 * 🔴 THE BROWSER PARSES IT, NOT A REGEX — the same decision, for the same reason,
 * that `component-setup.tsx` records at length: three successive regex extractors
 * there each shipped a defect (a comment glued to the next property, a `}` inside
 * a string truncating the capture), because several regexes cannot agree on where
 * a CSS block ends. `replaceSync` hands that to the engine that will evaluate it.
 */
function ledgerFromGlobals(): { css: string; ids: string[] } {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(globalsCss);
  const css: string[] = [];
  const ids: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (!rule.selectorText.includes('data-block-id')) continue;
        css.push(rule.cssText);
        for (const m of rule.selectorText.matchAll(/\[data-block-id\s*=\s*['"]?([^'"\]]+)['"]?\]/g))
          ids.push(m[1]);
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        walk(rule.cssRules);
      }
    }
  };
  walk(sheet.cssRules);
  return { css: css.join('\n'), ids };
}

/**
 * The production chain, reduced to what decides WIDTH.
 *
 * Mirrors `src/pages/apps/run/[slug]/[[...path]].tsx`: `AppLayout`'s no-scroll
 * `<main>` (a full-width flex column) and the run page's own wrapper Box. Both
 * are `width: 100%` with no bound of their own — that is the chain the defect
 * lived in, and the reason the cap has to be on the host rather than on them.
 */
function renderInPageChain(props: Partial<typeof baseProps> = {}) {
  return renderWithProviders(
    <div
      data-testid="layout-main"
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <div
        data-testid="page-wrapper"
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          width: '100%',
        }}
      >
        <PageBlockHost {...baseProps} {...props} fit="fill" />
      </div>
    </div>
  );
}

async function mountAt(width: number, height: number, props: Partial<typeof baseProps> = {}) {
  await page.viewport(width, height);
  renderInPageChain(props);
  await expect.element(page.getByTestId('app-page-frame')).toBeInTheDocument();
  // 🔴 TWO BOXES, AND WHICH ONE ANSWERS WHICH QUESTION IS THE POINT OF THIS SUITE.
  // The cap used to live on the FRAME (the host root), so frame and app column were
  // the same measurement and one element answered everything. They are now different
  // elements with OPPOSITE contracts:
  //   · `app-page-frame`   — the host root. Carries `AppBlockChrome`, and is FULL-BLEED
  //                          so the chrome spans the page like every other site bar.
  //   · `app-page-content` — the app's own column (iframe or failure card). This is
  //                          what the ultrawide cap binds.
  // `hostWidth` therefore reads the CONTENT box: every capped/centred claim below is
  // about the app column, and pointing it at the frame would make all of them assert
  // the opposite of the design. `frameWidth` is measured alongside so the full-bleed
  // half can be asserted rather than assumed.
  const frame = page.getByTestId('app-page-frame').element() as HTMLElement;
  const host = page.getByTestId('app-page-content').element() as HTMLElement;
  const parent = page.getByTestId('page-wrapper').element() as HTMLElement;
  // `measure` re-reads the live boxes, so a test can change the cascade and ask
  // again WITHOUT a second `renderInPageChain()` — two mounted trees would leave
  // two `app-page-frame` nodes in the document and every `getByTestId` after
  // that fails the strict-mode single-match rule.
  const measure = () => {
    const hostRect = host.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    return {
      hostWidth: hostRect.width,
      frameWidth: frame.getBoundingClientRect().width,
      parentWidth: parentRect.width,
      gutterLeft: hostRect.left - parentRect.left,
      gutterRight: parentRect.right - hostRect.right,
    };
  };
  return { host, frame, measure, ...measure() };
}

describe('PageBlockHost — the app stops growing on a wide display', () => {
  /**
   * 🔴 GUARD THE INSTRUMENT FIRST. Every claim below is "the host is narrower
   * than the space it was given", which is trivially satisfiable by a fixture
   * that never got a wide space in the first place — a `page.viewport` call that
   * silently did nothing would make the whole file pass while measuring a 414px
   * window. So the parent width is asserted against a literal before any host
   * width is believed.
   */
  test('POSITIVE CONTROL — the fixture really is 2560px wide at a 2560x1080 viewport', async () => {
    const { parentWidth } = await mountAt(2560, 1080);
    // Body margin + a possible scrollbar cost a few px; 2400 is far below any of
    // those and far above the runner's 414px default, so this can only pass if the
    // viewport call took effect.
    expect(
      parentWidth,
      'the fixture parent is not wide at a 2560px viewport — `page.viewport` did not ' +
        'take effect, and every width assertion in this file would pass vacuously'
    ).toBeGreaterThan(2400);
  });

  /**
   * 🔴 THE CHROME SPANS, THE APP DOES NOT — the pair that defines this layout, and
   * the half that is NEW. The cap used to sit on the host root, so the chrome was
   * capped along with the app and a full-page app read as a boxed widget dropped
   * into the page instead of a page of the site. The chrome is site furniture and
   * now behaves like it; the app keeps its measure.
   *
   * BOTH ARMS ARE IN ONE TEST DELIBERATELY. "The frame is full width" alone is green
   * on any revision where the cap simply does not work — including the pre-cap base —
   * so on its own it is an invariant guard, not coverage. Pairing it with "and the app
   * column inside it is NOT full width" is what makes this assert the actual delta:
   * two different widths, in the right order, on the right elements.
   */
  test('at 2560x1080 the chrome spans the page while the app column stays capped', async () => {
    const { frameWidth, hostWidth, parentWidth } = await mountAt(2560, 1080);

    expect(
      frameWidth,
      `at 2560x1080 the host frame is ${frameWidth}px inside a ${parentWidth}px parent — the ` +
        'chrome is being capped again. It is meant to span the page like every other site-level ' +
        'bar; the cap belongs on `app-page-content`, not on the frame.'
    ).toBe(parentWidth);

    expect(
      hostWidth,
      `at 2560x1080 the app column spans the whole ${parentWidth}px frame — the ultrawide cap ` +
        'moved off the content wrapper as well as off the frame, so nothing caps the app at all'
    ).toBeLessThan(frameWidth);
  });

  test('at 2560x1080 the host is a centred column, NOT the full monitor width', async () => {
    const { hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(2560, 1080);

    // THE REGRESSION CLAIM. Before the cap these two were equal, to the pixel.
    expect(
      hostWidth,
      `at a 2560x1080 viewport the host spans its whole ${parentWidth}px parent — the ` +
        'ultrawide cap is gone and an app is a single ~2500px column again'
    ).toBeLessThan(parentWidth);

    // LITERAL BOUNDS, deliberately not `APP_PAGE_MAX_WIDTH_PX` — see the header.
    // Lower: below ~1280 the cap would be narrower than the widest ORDINARY
    // civitai content measure (Mantine `xl`, 1320 border-box / 1288 content), i.e.
    // an app would render narrower than the store page that launched it.
    // Upper: ~1920 is the width `APPS_PAGE_CONTAINER_WIDTH` held when this bound was
    // chosen; that constant is now 2560 and the bound deliberately does not follow it
    // (see `__tests__/pageBlockHostMaxWidth.test.ts` — keeping 1920 is the tighter,
    // still-true ceiling, and the cap is 1600, nowhere near either).
    expect(hostWidth, 'at 2560x1080 the capped host is implausibly narrow').toBeGreaterThanOrEqual(
      1280
    );
    expect(hostWidth, 'at 2560x1080 the capped host is implausibly wide').toBeLessThanOrEqual(1920);

    // CENTRED, not left-aligned with the whole gutter dumped on one side. A
    // `max-width` WITHOUT `margin-inline: auto` gives exactly that, and it looks
    // like a rendering bug rather than a frame.
    expect(gutterLeft, 'at 2560x1080 there is no left gutter').toBeGreaterThan(0);
    expect(
      Math.abs(gutterLeft - gutterRight),
      `at 2560x1080 the app is not centred: ${gutterLeft}px left vs ${gutterRight}px right`
    ).toBeLessThanOrEqual(1);
  });

  test('at 3440x1440 (ultrawide) the cap still binds and the gutter grows with the display', async () => {
    const { hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(3440, 1440);

    expect(
      hostWidth,
      `at a 3440x1440 viewport the host spans its whole ${parentWidth}px parent`
    ).toBeLessThan(parentWidth);
    expect(hostWidth, 'at 3440x1440 the capped host is implausibly wide').toBeLessThanOrEqual(1920);
    // (3440 − 1920) / 2 = 760, so 700 holds for any cap inside the band above and
    // is a literal the implementation cannot satisfy by construction.
    expect(
      gutterLeft,
      'at 3440x1440 the gutter is far smaller than the cap implies — the host is not ' +
        'obeying the cap on a genuinely ultrawide display'
    ).toBeGreaterThan(700);
    expect(
      Math.abs(gutterLeft - gutterRight),
      `at 3440x1440 the app is not centred: ${gutterLeft}px left vs ${gutterRight}px right`
    ).toBeLessThanOrEqual(1);
  });

  /**
   * 🔴 THE HALF THAT MATTERS MOST. Almost all traffic is below the cap, so a
   * regression HERE is far worse than a suboptimal ultrawide. Both declarations
   * the fix adds are supposed to be inert at these sizes: `max-width` clamps
   * nothing because `width: 100%` already resolves narrower, and `margin-inline:
   * auto` has no leftover inline space to distribute.
   *
   * Asserted as EXACT equality on the width AND on the left edge, plus `0px`
   * computed margins. Equality is what "byte-identical geometry" means; a
   * tolerance would hide a small clamp, and the margin read is what
   * distinguishes "same width" from "same width, shifted".
   *
   * ⚠️ THESE THREE ARE GREEN ON THE BASE REVISION TOO, BY DESIGN — measured, 3/3.
   * That is not a vacuous pass: base-green IS the reference, and the claim is
   * that HEAD matches it. They are the only thing that would catch an
   * implementation that got the ultrawide case right by spending width
   * everywhere else (a percentage cap, a padded gutter, a `min()` on the width).
   * Do not count them as evidence that the cap WORKS — the wide cases above are
   * that, and they are the ones red at base.
   */
  test.each([
    [1024, 768],
    [1280, 900],
    [1440, 900],
  ])('below the cap (%ix%i) the geometry is unchanged — no clamp, no gutter', async (w, h) => {
    const { host, hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(w, h);

    expect(
      hostWidth,
      `at a ${w}x${h} viewport the host is ${hostWidth}px inside a ${parentWidth}px parent — ` +
        'the cap has started binding below its threshold, which changes the rendering for ' +
        'the viewports that carry the traffic'
    ).toBe(parentWidth);
    expect(gutterLeft, `at ${w}x${h} the host has been shifted right`).toBe(0);
    expect(gutterRight, `at ${w}x${h} the host has been shifted left`).toBe(0);

    const cs = getComputedStyle(host);
    expect(
      [cs.marginLeft, cs.marginRight],
      `at ${w}x${h} the auto margins resolved non-zero`
    ).toEqual(['0px', '0px']);
  });

  /**
   * 🔴 PROVE THE VALUE COMES FROM THE CUSTOM PROPERTY, NOT FROM A LITERAL IN THE
   * COMPONENT. The whole opt-out design rests on the host reading
   * `--app-page-max-width` through `var()` — if someone "simplified" it to an
   * inline number, or wrote the property inline on the host (where it would beat
   * every stylesheet rule), the two tests above would still pass and the
   * documented escape hatch would be silently inert.
   *
   * This drives the property to a value no implementation would pick and checks
   * the rendered width follows it exactly.
   */
  test('the cap is read from `--app-page-max-width` — overriding it moves the rendered width', async () => {
    injectCss(':root { --app-page-max-width: 900px; }');
    const { hostWidth } = await mountAt(2560, 1080);
    expect(
      hostWidth,
      'the host did not follow a `--app-page-max-width: 900px` override at 2560x1080 — the ' +
        'cap is not actually being read from the custom property, so no CSS opt-out can work'
    ).toBe(900);
  });

  /**
   * THE DOCUMENTED FULL-BLEED OPT-OUT, end to end: the ledger in `globals.css`
   * keys on `data-app-page-frame` + `data-block-id`, both of which the host
   * stamps on its root.
   *
   * Both halves are in ONE test on purpose. The second assertion alone is GREEN
   * on the base revision (an uncapped host is full width for reasons that have
   * nothing to do with the opt-out), so it would be an invariant guard rather
   * than coverage. Pairing it with the capped measurement makes the test assert
   * a DELTA — the rule changed something — which is only true once both the cap
   * and the `data-block-id` anchor exist.
   *
   * ⚠️ THIS TIER IS STRUCTURALLY BLIND TO THE ONE DEFECT THAT ACTUALLY SHIPPED,
   * AND SAYING SO IS THE POINT. The selector below used to read
   * `[data-testid='app-page-frame'][data-block-id='…']`, which is what
   * `globals.css` shipped — and `next.config.mjs` strips every `data-testid` from
   * the DOM under `NODE_ENV === 'production'`, so on the live site it matched
   * nothing and `playable-collections` was letterboxed at the cap. This test
   * passed throughout, because vitest never runs with `NODE_ENV=production`; no
   * assertion added here can change that. The check that CAN see it compares the
   * two configurations instead of rendering:
   * `__tests__/ledgerSelectorSurvivesProdStrip.test.ts`. Do not "strengthen" this
   * test to cover it — widen that one.
   */
  test('an app can opt out of the cap with a CSS rule keyed on `data-block-id`', async () => {
    const { measure, hostWidth, parentWidth } = await mountAt(2560, 1080);
    expect(hostWidth, 'the host is not capped at 2560x1080 to begin with').toBeLessThan(
      parentWidth
    );

    injectCss(`[data-app-page-frame][data-block-id='${BLOCK_ID}'] { --app-page-max-width: none; }`);
    const optedOut = measure();
    expect(
      optedOut.hostWidth,
      'the ledger rule shape documented on `--app-page-max-width` in globals.css did not ' +
        'restore full-bleed at 2560x1080 — either `data-app-page-frame`/`data-block-id` are no ' +
        'longer stamped on the host root or the cap is no longer overridable, and every opt-out ' +
        'in that ledger is inert'
    ).toBe(optedOut.parentWidth);
  });

  /**
   * 🔴 THE LEDGER'S ONE REAL MEMBER, EXERCISED AGAINST THE SHIPPED RULE.
   *
   * `playable-collections` is opted out of the cap by an explicit product
   * decision: every one of its open-collection surfaces is uncapped by the app
   * (the 960px well it has applies only to its browse shell, behind an early
   * return), so a centred column shrinks the player and truncates the ticker and
   * wall grids. The reasoning, with file:line evidence, is on the rule itself in
   * `globals.css`; the membership set is pinned in
   * `__tests__/pageBlockHostMaxWidth.test.ts`.
   *
   * THIS IS A PAIR, and the second arm is what makes the first mean anything.
   * Both arms render at 2560 with the SAME real ledger CSS injected and differ
   * ONLY in `blockId`. Without the second arm, "the host is full width" is
   * satisfied by a cap that stopped working for every app.
   */
  test('LEDGER — `playable-collections` is full-bleed at 2560x1080 while another app stays capped', async () => {
    const ledger = ledgerFromGlobals();

    // POSITIVE CONTROL on the extraction itself. If the parse returned nothing —
    // a renamed property, a rule moved into an at-rule this walk skips, or a
    // `?raw` import that silently resolved to an empty string — the green arm
    // would fail with a confusing width mismatch instead of naming the cause.
    expect(
      ledger.ids,
      'no `[data-block-id=…]` rules were parsed out of src/styles/globals.css. Either the ' +
        'full-bleed ledger is empty (then this test should be deleted deliberately, together ' +
        'with the membership expectation in __tests__/pageBlockHostMaxWidth.test.ts), or the ' +
        'rules moved somewhere this walk does not reach.'
    ).toContain('playable-collections');
    injectCss(ledger.css);

    // GREEN ARM — the opted-out app takes the full width of its parent.
    const optedOut = await mountAt(2560, 1080, { blockId: 'playable-collections' });
    expect(
      optedOut.hostWidth,
      'at 2560x1080 the app `playable-collections` is NOT full-bleed. Its ledger rule in ' +
        'src/styles/globals.css is missing, mistyped, or no longer overrides ' +
        '`--app-page-max-width` — so a collection player whose every view mode is uncapped by ' +
        'the app is being letterboxed to the default cap again.'
    ).toBe(optedOut.parentWidth);

    // The two arms mount separately, so the first tree has to go: two mounted
    // `app-page-frame` nodes would fail every `getByTestId` on the strict-mode
    // single-match rule.
    await cleanup();

    // RED-PAIR ARM — an app NOT in the ledger, same cascade, still capped. This
    // is what distinguishes "the ledger works" from "the cap stopped working".
    const stillCapped = await mountAt(2560, 1080, { blockId: BLOCK_ID });
    expect(
      stillCapped.hostWidth,
      `at 2560x1080 the app '${BLOCK_ID}' is full-bleed despite having NO ledger entry. The ` +
        'opt-out is matching apps it should not — check the ledger selector is keyed on ' +
        '`data-block-id` and not on something every host carries.'
    ).toBeLessThan(stillCapped.parentWidth);
  });

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — green on the base revision too,
   * and labelled here so it is never counted as proof the cap works.
   *
   * The claim it pins is about the SAFE-AREA insets, which went live with
   * `viewport-fit=cover`: in landscape on a notched device `--safe-area-inset-
   * left`/`-right` are ~47px, and the shell pays only the TOP inset globally
   * (`#__next { padding-top: … }` in globals.css), so left/right are unpaid for
   * in-flow page content. The question this answers is whether the new gutter can
   * interact with them — i.e. whether a viewport can be BOTH wider than the cap
   * and carrying a non-zero inline inset. It cannot: the widest notched device in
   * landscape is ~1000 CSS px, far below the cap, so the cap is inert wherever an
   * inset exists and the two mechanisms never meet. Pinned rather than asserted
   * in prose because "no device does both" is exactly the kind of claim that goes
   * stale silently.
   */
  test('INVARIANT — at a notched phone landscape size (932x430) the cap is inert, so it cannot fight the safe-area insets', async () => {
    injectCss(':root { --safe-area-inset-left: 47px; --safe-area-inset-right: 47px; }');
    const { hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(932, 430);
    expect(
      hostWidth,
      'the cap has started binding at 932x430 — it now overlaps the viewport class where the ' +
        'display-cutout insets are non-zero, and the gutter and the insets have to be reasoned ' +
        'about together'
    ).toBe(parentWidth);
    expect([gutterLeft, gutterRight], 'at 932x430 the host is no longer flush').toEqual([0, 0]);
  });
});
