import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * THE FULL-PAGE APP BLOCK IS UNCAPPED — MEASURED, at named viewports.
 *
 * THE CONTRACT. `/apps/run/<slug>` hands the app the viewport. NOTHING in the chain
 * bounds it: the page wrapper is `width: '100%'`, the host root is `width: '100%'`, the
 * content wrapper is `width: '100%'` AND DECLARES NO `max-width` OF ANY KIND, and the
 * iframe is `width: '100%'`. An app that wants a centred column sets one in its own CSS,
 * inside its own iframe document.
 *
 * ⚠️ THIS FILE USED TO MEASURE THE OPPOSITE, AND THE INVERSION IS THE POINT. The host
 * capped a full-page app at 1600px and centred it past that, and these cases asserted
 * the cap bound at 2560 and 3440. The cap was dropped by an owner decision; the whole
 * record — including what the 1600 was worth and what it cost — is the tombstone above
 * `PageBlockHostProps` in `src/components/AppBlocks/PageBlockHost.tsx`. What is preserved
 * here is the SHAPE of the old suite, because it was the right shape: measure at named
 * viewports, pair every claim with a control, and keep the below-threshold arm as the
 * reference it always was.
 *
 * ⚠️ AND IT MEASURED AN INTERMEDIATE CONTRACT TOO, WHICH IS NOW ALSO GONE — SAID PLAINLY
 * BECAUSE THREE ARMS DISAPPEARED WITH IT AND A LATER READER WOULD OTHERWISE LOOK FOR ROT.
 * Between the cap and now, `--app-page-max-width` survived at `none` with the per-app CSS
 * mechanism kept and re-pointed, so a rule could CAP one app. Three arms here exercised
 * that: "the width is read from `--app-page-max-width` — overriding it moves the rendered
 * width", "a per-app platform rule CAN still cap one app — and only that app" (with its
 * paired negative arm), and "every per-app rule in globals.css is REACHABLE by the CSSOM
 * walk". The mechanism is deleted — property, `var()` read, `margin-inline: auto`, ledger,
 * template, publisher HOW-TO — so all three had no subject left. Their helpers went with
 * them (`ledgerRulesIn`, `ledgerFromGlobals`, `cssomWalkPositiveControl`,
 * `templateCapPxFromGlobals`, `cssWithoutComments`, and the `?raw` import of `globals.css`
 * every one of them read). What REMAINS is every arm that measures a WIDTH, which is the
 * requirement; nothing that measured a LEVER.
 *
 * 🔴 THE BOUNDARY IS 1600, NOT 1905 — AND THE ~1905 READING IS RETRACTED HERE BECAUSE IT
 * SHIPPED IN THIS FILE'S FIRST DRAFT AND IN AN ASSERTION MESSAGE. A `max-width: 1600px`
 * binds at ANY viewport wider than 1600 — 1601, 1680, 1728, 1792 — so the narrowest
 * viewport it bound at is 1600-and-a-bit, not 1905. 1905 was only the *old* docblock's
 * illustration of a common desktop ("a maximised browser at 1080p"); it never claimed to
 * be a threshold, and promoting it to one put the boundary ~300px too high and left
 * 1601–1904 unmeasured — exactly the band where the cap DID bind.
 *
 * MEASURED against the base revision with this fixture, which is why these are the arms:
 *
 *   1536x960  host 1536 == parent, gutter 0     ← inert
 *   1600x1000 host 1600 == parent, gutter 0     ← inert AT the cap, the tightest below-point
 *   1620x1000 host 1600  in a 1620px parent, gutter 10   ← BINDS, the tightest above-point
 *   1905x1080 host 1600  in a 1905px parent, gutter 152.5 ← the old docblock's 1080p case
 *   2560x1080 host 1600, gutter 480
 *   3440x1440 host 1600, gutter 920
 *
 * So the below-arm and the uncapped-arm now genuinely MEET at 1600/1620, and 1905 is kept
 * as the named real-world case with its own measured figure rather than as the threshold.
 *
 * ⚠️ THOSE GUTTERS ARE READ FROM THIS HARNESS, AND A REVIEW PREDICTED THEY COULD NOT BE — worth
 * recording, because the reasoning behind the prediction is sound and the conclusion is still
 * wrong. The argument: this tier loads no CSS reset (`test/component-setup.tsx` injects only
 * `:root` custom properties, by design), so `document.body` should keep the UA `margin: 8px`
 * and the fixture parent should be `viewport − 16` — which would make the 1620 arm red by 2px
 * a side, not 10. Checked by printing `parentWidth` from `mountAt` itself at the base revision:
 * it is **1620 at a 1620 viewport and 1905 at a 1905 viewport**, i.e. the parent DOES equal the
 * viewport here. The review measured a plain Chromium page rather than vitest's tester iframe
 * and flagged that gap itself. Do not "correct" the table from first principles — print
 * `parentWidth`, which the POSITIVE CONTROL below already does for 2560.
 * 🔴 WIDTH-DEPENDENT BEHAVIOUR CAN DIFFER OR INVERT BETWEEN POINTS, so every claim is made
 * at a boundary AND above it, with every number in the assertion message.
 *
 * 🔴 MUTATION CONTROL, RUN AGAINST THIS CONTRACT (recorded here because a mutation result
 * that lives only in a PR description is not evidence anyone can re-read). Putting a bare
 * `maxWidth: 1600` back on the content element in `PageBlockHost.tsx` — the value the old
 * cap used — takes this file to **5 failed | 9 passed of 14 arms**: the 1620/1905/2560/3440
 * arms fail with THIS suite's own message ("the app column is 1600px inside a 1620px parent
 * — it is being capped, with 10px of gutter on the left"), AND so does
 * `at 2560x1080 the chrome spans the page and so does the app column`, on its second
 * assertion (`hostWidth` → `frameWidth`, `expected 1600 to be 2560`). 🔴 THAT FIFTH ARM IS
 * THE CORRECTION: this figure read "4 failed | 10 passed" because the sentence enumerated
 * only the `test.each` widths and forgot the chrome/app pair, which is also a width claim.
 * It is the THIRD time this figure has been wrong — see the retraction below — and it is
 * the number a future reader uses to decide whether their own run is complete, so RE-RUN
 * rather than trusting it. A Tailwind `max-w-[1600px]` class is the mirror case and is
 * INVISIBLE here — this harness loads no Tailwind — which is why the node tier pins the
 * class route separately.
 *
 * ⚠️ QUOTE THAT FIGURE WITH ITS ARM COUNT, BECAUSE IT WENT STALE TWICE AND THAT IS THE
 * WHOLE HAZARD OF RECORDING A COUNT. It first read "5 failed | 8 passed" (13 arms, i.e.
 * before the round that added 1620/390/1366/1600, so the recorded run could not have seen
 * the 1620 arm it named), then "6 failed | 11 passed at 17 arms" against a mutant
 * (`--app-page-max-width: 1600px` on `:root`) that is no longer expressible, since the
 * property does not exist. A count is only readable against the arm total AND the mutant it
 * was taken at; re-run rather than quoting.
 *
 * ⚠️ TWO RECORDED MUTANTS ARE RETIRED RATHER THAN CARRIED FORWARD, BECAUSE THEY ARE NO
 * LONGER CONSTRUCTIBLE. Both were per-app ledger selectors —
 * `[data-app-page-frame][data-block-id*='sensei']` and the `[data-block-id='sensei' i]`
 * flag form — each of which capped an app in production while every tier was green, and
 * both were killed by the ledger MEMBERSHIP enumeration in the node tier rather than by
 * anything here. With no ledger there is no such rule to write, so the enumeration, the
 * shared selector predicate it used and these two mutants all go together. The transferable
 * half is the shape, not the instance: a route that never touches the host's own source is
 * invisible to a source guard, and a route that never renders in this harness's cascade is
 * invisible here.
 *
 * 🔴 THIS FILE IMPORTS NOTHING FROM THE HOST BUT THE COMPONENT, ON PURPOSE.
 *
 * The obvious spelling — import a width constant and assert the rendered width equals it
 * — is the self-referential trap `FILL_MIN_HEIGHT_PX` already recorded: it compares a
 * measurement against the very constant that produced it, so it is true by construction
 * for every value including a broken one. (There is no such constant any more — see the
 * note where `APP_PAGE_MAX_WIDTH_PX` used to be declared in `PageBlockHost.tsx` — which
 * makes the point moot and the discipline still right.) It has a second cost that matters
 * more: a file that imports a symbol which does not exist on the base revision fails to
 * COLLECT, and a collection failure reports "no tests" rather than a red assertion —
 * indistinguishable from a suite wired to nothing. Every expectation below is either a
 * LITERAL bound or a comparison between two things measured in the same render, so this
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
 *
 * 🔴 WHAT NEITHER TIER CAN SEE, STATED BECAUSE THE UNCAP MADE IT LOAD-BEARING. The
 * component harness does NOT load the app cascade — `test/component-setup.tsx` extracts
 * only the unconditional `:root` CUSTOM PROPERTIES out of `globals.css`, because importing
 * the stylesheet pulls Tailwind preflight and Mantine layer ordering and changes the
 * rendered geometry of every existing test. So a plain `max-width` rule in `globals.css`,
 * e.g. `[data-app-page-frame] > div { max-width: 1600px; margin-inline: auto; }`, would
 * re-cap every full-page App Block in production and be invisible here — never injected —
 * while also never appearing in the host's JSX, which is all the node tier reads. With no
 * bound declared anywhere, the only rendered evidence that no cap exists comes from a
 * cascade this suite builds itself, so that blind spot is the cheapest way to reintroduce
 * one unnoticed.
 *
 * ⚠️ THE FIRST VERSION OF THIS NOTE JUSTIFIED LEAVING IT UNGATED WITH "zero instances in this
 * file's history", WHICH IS THE WRONG DENOMINATOR AND CONTRADICTED THE SENTENCE BEFORE IT: if
 * the uncap makes this the cheapest way to reintroduce a cap, the base rate just changed and
 * history cannot price it. The narrow half is GATED in the node tier —
 * `src/components/AppBlocks/__tests__/pageBlockHostMaxWidth.test.ts` has a
 * `no bare max-width rule targets the app host box` assertion that greps `globals.css` for a
 * `max-width` declaration under any selector naming the host's own markers, with two
 * synthetic positive controls. What stays ungated is the WIDE half — a cap arriving from any
 * other stylesheet, or via the cascade this harness does not load — because closing that
 * means loading the real app cascade, which moves every other browser suite's geometry. Know
 * that before trusting a green run here.
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
      // CREATE_POST_FROM_APP is TWO block-token mutations — the read-only preview
      // that resolves the consent payload, and the write. PageBlockHost reads both
      // at render, so a mock missing either makes the WHOLE component throw and
      // every measurement in the file reads as an empty DOM.
      previewPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
      createPostFromApp: { useMutation: () => ({ mutateAsync: vi.fn() }) },
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

/**
 * The app slug the fixture runs as.
 *
 * ⚠️ IT USED TO BE MORE THAN A FIXTURE NAME: it was the key a per-app platform width rule was
 * written against, and this comment has been corrected twice about which DIRECTION such a rule
 * pointed in (an opt-out from a default cap, then an imposition against no default). Both
 * readings are retired — there is no such rule and no ledger to write one in, so this is now
 * an ordinary fixture slug with no cascade meaning at all.
 */
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
 * which would silently change the cascade for every case after it. Only one arm still
 * injects anything — the safe-area invariant, which sets the display-cutout insets — but the
 * teardown stays because a leak is silent and a second injecting arm costs nothing to add.
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
 * The production chain, reduced to what decides WIDTH.
 *
 * Mirrors `src/pages/apps/run/[slug]/[[...path]].tsx`: `AppLayout`'s no-scroll
 * `<main>` (a full-width flex column) and the run page's own wrapper Box. Both
 * are `width: 100%` with no bound of their own, and so is the host — the platform
 * imposes no width anywhere in this chain.
 *
 * ⚠️ THIS DOCBLOCK HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND BOTH RETRACTIONS ARE
 * KEPT. It first said the chain was "the reason the cap has to be on the host" — a
 * present-tense claim that a cap must exist. It then said the chain shows nothing here would
 * bound an app if the host did not, "which is why a per-app platform rule, if one is ever
 * wanted, has to be read on the host and nowhere else" — true about the chain, but it named a
 * lever that has since been deleted. The surviving claim is the first half alone: nothing in
 * this chain bounds an app, and the host does not either, so the app's own document is the
 * only place a measure can come from.
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
  // A cap used to live on the FRAME (the host root), so frame and app column were the
  // same measurement and one element answered everything. They are now different
  // elements:
  //   · `app-page-frame`   — the host root. Carries `AppBlockChrome`, and is FULL-BLEED
  //                          so the chrome spans the page like every other site bar.
  //   · `app-page-content` — the app's own column (iframe or failure card). Its width IS
  //                          the app's measure, so it is the box every claim below is about.
  // `hostWidth` therefore reads the CONTENT box; pointing it at the frame would make those
  // claims assert something else entirely. `frameWidth` is measured alongside so the
  // full-bleed half can be asserted rather than assumed. ⚠️ THIS COMMENT HAS BEEN CORRECTED
  // TWICE AND BOTH RETRACTIONS ARE KEPT: it read "This is what the ultrawide cap binds" and
  // "every capped/centred claim below" while no cap existed, and was then corrected to
  // "the box that READS `--app-page-max-width` … exactly ONE arm below is a capped claim,
  // and it injects the rule that makes it one" — which described a mechanism and an arm that
  // are both now deleted. NO arm below is a capped claim; every one asserts the app column
  // equals its parent.
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

describe('PageBlockHost — the app takes the whole width, at every display size', () => {
  /**
   * 🔴 GUARD THE INSTRUMENT FIRST — AND THE HAZARD IT GUARDS HAS INVERTED, SO THE
   * REASONING IS RESTATED RATHER THAN INHERITED.
   *
   * It used to read: every claim below is "the host is narrower than the space it was
   * given", trivially satisfiable by a fixture that never got a wide space. That is no
   * longer what this suite claims. Every claim is now `hostWidth === parentWidth` — which
   * a 414px fixture satisfies just as vacuously, and MORE quietly, because an equality
   * between two numbers that are both wrong looks exactly like an equality between two
   * numbers that are both right. The runner's default viewport is 414px WIDE, narrower
   * than a phone in landscape, so a `page.viewport` call that silently did nothing would
   * make this entire file pass while measuring a window at which the feature is inert.
   *
   * So the parent width is asserted against a literal before any host width is believed.
   */
  test('POSITIVE CONTROL — the fixture really is 2560px wide at a 2560x1080 viewport', async () => {
    const { parentWidth } = await mountAt(2560, 1080);
    expect(
      parentWidth,
      'the fixture parent is not wide at a 2560px viewport — `page.viewport` did not ' +
        'take effect, and every width assertion in this file would pass vacuously'
    ).toBeGreaterThan(2400);

    // 🔴 EXACT EQUALITY, WHICH MAKES A CLAIM IN THIS FILE'S HEADER MACHINE-CHECKED INSTEAD OF
    // REMEMBERED. The header's base-revision gutter table (10px a side at 1620, 152.5 at 1905)
    // only holds if the fixture parent EQUALS the viewport, and a review argued it could not:
    // this tier loads no CSS reset, so `document.body` should keep the UA `margin: 8px` and the
    // parent should be `viewport − 16`. ⚠️ THE OLD COMMENT HERE AGREED WITH THAT REVIEW — it
    // said "Body margin + a possible scrollbar cost a few px" and then asserted only `> 2400`,
    // so the file contained both claims and checked neither. This assertion settles it: GREEN
    // means the parent really is the viewport and the header's table stands; RED means the
    // review was right, the table needs re-deriving from a printed `parentWidth`, and the 1620
    // arm's real margin is 2px a side rather than 10.
    //
    // ⚠️ AND THIS ONE WIDTH IS NOT THE WHOLE TABLE, WHICH AN EARLIER VERSION OF THIS COMMENT
    // CLAIMED IT WAS. Body margin is width-INDEPENDENT, so 2560 does settle the mechanism the
    // review named — but a vertical SCROLLBAR is a different one, and it is likeliest at the
    // SHORTEST viewports, not here. So `parentWidth === w` is now asserted inside BOTH `test.each`
    // arms as well, at every width they already mount, for zero extra renders. This assertion
    // stays as the instrument guard it has always been: it runs first, and it pins the one width
    // every other test's `hostWidth === parentWidth` comparison is calibrated against.
    expect(
      parentWidth,
      'the fixture parent is not EXACTLY the viewport width at 2560x1080. That invalidates the ' +
        "base-revision gutter table in this file's header, which is computed as (viewport − " +
        '1600) / 2 and assumes parent === viewport. Re-derive that table by printing ' +
        '`parentWidth` from `mountAt` at each width rather than adjusting it by arithmetic, and ' +
        'note the 1620 arm then has a ~2px margin instead of ~10px.'
    ).toBe(2560);
  });

  /**
   * 🔴 THE CHROME AND THE APP TAKE THE SAME MEASURE — THE VIEWPORT — AND BOTH ARMS ARE
   * IN ONE TEST DELIBERATELY.
   *
   * The two elements have opposite histories and neither one alone says anything useful.
   * "The frame is full width" was already true while the cap existed (the cap moved OFF
   * the frame precisely so the chrome could span the page like every other site-level
   * bar), so on its own it is an invariant guard. "The app column is full width" is the
   * new claim. Asserting them TOGETHER, as an equality chain against the parent, is what
   * pins the whole layout: chrome == frame == app column == parent, at a width where the
   * old cap bound hard.
   *
   * ⚠️ THIS TEST IS THE INVERSION OF THE ONE IT REPLACED, which asserted
   * `hostWidth < frameWidth` here. Kept in place rather than deleted so the diff shows a
   * contract that changed rather than coverage that vanished.
   */
  test('at 2560x1080 the chrome spans the page and so does the app column — nothing is capped', async () => {
    const { frameWidth, hostWidth, parentWidth } = await mountAt(2560, 1080);

    expect(
      frameWidth,
      `at 2560x1080 the host frame is ${frameWidth}px inside a ${parentWidth}px parent — the ` +
        'chrome is being bounded. It is meant to span the page like every other site-level bar.'
    ).toBe(parentWidth);

    expect(
      hostWidth,
      `at 2560x1080 the app column is ${hostWidth}px inside a ${frameWidth}px frame, i.e. ` +
        'something is capping the app. The platform imposes no width on a full-page App Block: ' +
        'the content wrapper in `PageBlockHost.tsx` declares `width: 100%` and no `max-width` of ' +
        'any kind. So a bound has been added — in the inline style, as a Mantine `maw`/`w` style ' +
        'prop, as a substituted root component that carries its own measure, or as a rule in a ' +
        'stylesheet this harness does happen to load. The node-tier guard covers the first three; ' +
        'read its output alongside this one.'
    ).toBe(frameWidth);
  });

  /**
   * 🔴 THE BOUNDARY CASE, AND THE ONE THAT ACTUALLY DISTINGUISHES HEAD FROM BASE.
   *
   * 1620 is the tightest point at which THIS SUITE observes the uncap: the old cap was
   * `max-width: 1600px`, so at a 1620px parent it bound by exactly 10px a side. Measured
   * against the base revision, not reasoned — and the sibling arm below measures 1600,
   * where it was still inert, so the two arms MEET at the real boundary.
   *
   * ⚠️ "TIGHTEST POINT THE CAP BOUND AT" WOULD BE AN OVERCLAIM AND THIS FILE MADE IT ONCE: a
   * 1600px cap binds from 1601 up, so 1620 is the tightest point MEASURED, not the infimum.
   * The distinction matters because it is the same class of error as the ~1905 reading this
   * header retracts — a test point promoted to a property of the mechanism.
   *
   * ⚠️ 1905 IS KEPT BUT IT IS NOT THE BOUNDARY, AND THIS FILE SAID IT WAS. See the header
   * for the retraction; in short, 1905 was the old docblock's illustration of a maximised
   * browser at 1080p (gutter 152.5px a side, measured), which is a real-world case worth an
   * arm and is ~305px above the actual threshold.
   *
   * 🔴 MEASURED AT FOUR WIDTHS — THE BOUNDARY (1620), A COMMON DESKTOP (1905), A MIDDLE
   * (2560) AND AN ULTRAWIDE (3440) — BECAUSE WIDTH-DEPENDENT BEHAVIOUR CAN DIFFER OR EVEN
   * INVERT BETWEEN POINTS. A single wide sample could be satisfied by a cap that happens to
   * sit above it; a single boundary sample could be satisfied by a percentage bound that
   * only bites further out. Every number is in the message so a failure carries its own
   * scope, and the message no longer names a threshold it cannot support.
   *
   * At base (the 1600px cap) all four of these are RED, and they are the arms to read
   * first when this file goes red: they are the contract, not a bound.
   */
  test.each([
    [1620, 1000],
    [1905, 1080],
    [2560, 1080],
    [3440, 1440],
  ])(
    'at %ix%i the app column is FULL WIDTH with no gutter — 1620 is the tightest point this suite measures the old 1600px cap binding at',
    async (w, h) => {
      const { hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(w, h);

      // The header's base-revision gutter table derives every NON-ZERO figure as
      // (viewport − 1600) / 2, which is only true where the fixture parent IS the viewport.
      // Pinned at every width rather than only at 2560, because the mechanism that could break it
      // at a SHORT viewport (a vertical scrollbar) is not the one 2560 settles (the UA body
      // margin). ⚠️ "EVERY gutter figure" would be wrong and was: the table's 1536 row is a
      // CLAMPED zero (the formula gives −32, and a negative is not a gutter) and its 1600 row is
      // zero because the formula genuinely evaluates to 0 there — only the first is clamped.
      expect(
        parentWidth,
        `at ${w}x${h} the fixture parent is ${parentWidth}px, not the ${w}px viewport. Every ` +
          "NON-ZERO gutter figure in this file's header is (viewport − 1600) / 2 and assumes the " +
          'two are equal, so that table needs re-deriving from these printed values.'
      ).toBe(w);

      expect(
        hostWidth,
        `at a ${w}x${h} viewport the app column is ${hostWidth}px inside a ${parentWidth}px ` +
          `parent — it is being capped, with ${gutterLeft}px of gutter on the left and ` +
          `${gutterRight}px on the right. The platform is meant to impose no width at all on a ` +
          "full-page App Block: the content wrapper declares `width: '100%'` and no `max-width` " +
          'in any spelling. READ THE ARM THAT FAILED: a bound ' +
          'reintroduced at value V fails every arm whose viewport exceeds V and no arm below ' +
          'it, so the narrowest RED arm brackets V from above and the widest GREEN arm (see the ' +
          'unchanged-geometry arm, which runs up to 1600) brackets it from below. 1620 failing ' +
          'alone means a bound at or just under 1620; only 3440 failing means a bound between ' +
          '2560 and 3440.'
      ).toBe(parentWidth);

      expect(
        [gutterLeft, gutterRight],
        `at ${w}x${h} the app column is not flush with its parent: ${gutterLeft}px left, ` +
          `${gutterRight}px right. An uncapped box has no leftover inline space for ` +
          '`margin-inline: auto` to distribute, so both must be exactly 0.'
      ).toEqual([0, 0]);
    }
  );

  /**
   * 🔴 THE HALF THAT MATTERS MOST, AND IT IS UNCHANGED BY THIS CHANGE — WHICH IS THE
   * CLAIM. Most traffic is below 1600px, so a regression HERE is far worse than a
   * suboptimal ultrawide. The former cap did not bind at or below 1600, so removing it
   * must move nothing at those widths: they were full-width before and must be full-width
   * now.
   *
   * Asserted as EXACT equality on the width AND on both gutters, plus `0px` computed
   * margins. Equality is what "byte-identical geometry" means; a tolerance would hide a
   * small clamp, and the margin read is what distinguishes "same width" from "same width,
   * shifted".
   *
   * ⚠️ THESE ARE GREEN ON THE BASE REVISION TOO, BY DESIGN — that is what makes them the
   * REFERENCE rather than the coverage. Base-green IS the expected value, and the claim is
   * that HEAD matches it. Do not count them as evidence that the uncap works; the
   * 1620/1905/2560/3440 arm above is that, and those are the ones red at base.
   *
   * THE POINTS, AND WHY EACH IS HERE: 390x844 a phone in portrait; 1024x768 a tablet;
   * 1280/1366/1440/1536 the four laptop classes the old cap's docblock named — ALL FOUR,
   * because naming a set and measuring three of it is how a docstring ends up wider than
   * its body; and **1600x1000, the exact cap value**, which is the tightest width at which
   * the old cap was still INERT (measured at base: host 1600 == parent, gutter 0). That
   * last point is what makes this arm meet the uncapped arm's 1620 at the real boundary.
   * ⚠️ It previously stopped at 1536, on the stated reasoning that 1536 was "the nearest
   * width BELOW the ~1905 boundary" — false twice over: the boundary is 1600, and
   * 1537–1904 was therefore left unmeasured by both arms.
   */
  test.each([
    [390, 844],
    [1024, 768],
    [1280, 900],
    [1366, 900],
    [1440, 900],
    [1536, 960],
    [1600, 1000],
  ])(
    'at or below the former cap (%ix%i) the geometry is unchanged — no clamp, no gutter',
    async (w, h) => {
      const { host, hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(w, h);

      // Same pin as the uncapped arm: parent === viewport, at every width this arm mounts.
      // ⚠️ NOT justified by the header's arithmetic, which has no formula-derived figure in this
      // band at all — every row here is a clamped zero. The reason is the one the POSITIVE CONTROL
      // gives: an equality between two numbers that are BOTH wrong looks exactly like an equality
      // between two numbers that are both right, and `hostWidth === parentWidth` is precisely that
      // shape. 390x844 is the narrowest `mountAt` in the file, so it is the likeliest place a
      // vertical scrollbar makes the parent smaller than the viewport and both sides shrink
      // together.
      expect(
        parentWidth,
        `at ${w}x${h} the fixture parent is ${parentWidth}px, not the ${w}px viewport.`
      ).toBe(w);

      expect(
        hostWidth,
        `at a ${w}x${h} viewport the host is ${hostWidth}px inside a ${parentWidth}px parent — ` +
          'something has started bounding the app at a width that carries the traffic, which is a ' +
          'worse regression than anything the ultrawide arms can catch'
      ).toBe(parentWidth);
      expect(gutterLeft, `at ${w}x${h} the host has been shifted right`).toBe(0);
      expect(gutterRight, `at ${w}x${h} the host has been shifted left`).toBe(0);

      // ⚠️ THIS MESSAGE SAID "the auto margins resolved non-zero" AND THERE ARE NO AUTO
      // MARGINS ANY MORE — retracted. `margin-inline: auto` existed only to centre a capped
      // column and was deleted with the cap, so a non-zero value here can no longer be an
      // auto margin resolving against leftover space; it is a margin arriving from somewhere
      // that has no business setting one. The assertion is unchanged and still correct — only
      // its explanation was a claim about a deleted mechanism, which is the exact class this
      // suite retracts elsewhere and the one the round that deleted the mechanism missed here.
      const cs = getComputedStyle(host);
      expect(
        [cs.marginLeft, cs.marginRight],
        `at ${w}x${h} the app column resolved a non-zero inline margin (${cs.marginLeft} / ` +
          `${cs.marginRight}). Nothing in the host declares one: the \`margin-inline: auto\` ` +
          'that used to centre a capped column is gone with the cap, so this is coming from a ' +
          'stylesheet, a substituted component, or a width bound that reintroduced centring.'
      ).toEqual(['0px', '0px']);
    }
  );

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled so it is never counted as proof
   * that the uncap works. The arms that are red at base are the 1620/1905/2560/3440 ones.
   *
   * The claim it pins is about the SAFE-AREA insets, which went live with
   * `viewport-fit=cover`: in landscape on a notched device
   * `--safe-area-inset-left`/`-right` are ~47px, and the shell pays only the TOP inset
   * globally (`#__next { padding-top: … }` in globals.css), so left and right are
   * deliberately unpaid for in-flow page content. The question is whether the app column
   * stays flush with its parent at a viewport where those insets are non-zero — i.e.
   * whether anything in the chain has started spending them as `padding-inline`,
   * `margin-inline` or a bound, which would inset a third-party app by ~47px a side on a
   * notched phone in landscape and nowhere else.
   *
   * ⚠️ RE-POINTED TWICE, AND BOTH PREVIOUS SHAPES ARE RECORDED BECAUSE THIS ARM KEEPS
   * BEING THE ONE WHOSE SUBJECT MOVES. (1) It originally asserted the 1600px DEFAULT cap
   * was inert at 932x430 — which became trivially true, and therefore said nothing, the
   * moment the default went to `none`. (2) It was then re-pointed to inject a PER-APP cap
   * at the value the `globals.css` template taught, alongside the insets, and assert the app
   * was flush even then — the argument being that the widest notched device in landscape is
   * ~1000 CSS px, below that value, so a centring gutter and the insets could never meet.
   * That mechanism is now deleted: there is no template, no per-app rule and no custom
   * property to inject, so `templateCapPxFromGlobals` and the `CAP > 1000` assertion that
   * guarded the margin between the two went with it.
   *
   * 🔴 SO THE CENTRING-GUTTER HALF OF THIS ARM IS GONE, AND THAT IS A NARROWING RATHER THAN
   * A SIMPLIFICATION — SAY WHICH. With no platform bound there is no gutter for the insets
   * to interact with, so the "two mechanisms never meet" claim has one mechanism left and
   * cannot be made at all. What survives is the half that was always about the INSETS: they
   * are non-zero here, and the app column must still be exactly its parent's width with
   * zero gutter and zero resolved margin. If a platform width bound is ever proposed again,
   * the interaction question comes back with it and this is the arm to extend.
   *
   * 🔴 THE INSETS ARE PROVEN LIVE BEFORE ANYTHING IS PROVEN INERT — otherwise this test
   * cannot distinguish "the insets are not spent on the app column" from "the injected
   * properties never reached the box", and both give `hostWidth === parentWidth`. That is
   * the same vacuity the previous re-point was made to avoid, one mechanism over.
   */
  test('INVARIANT — at a notched phone landscape size (932x430) the display-cutout insets are not spent on the app column', async () => {
    injectCss(':root { --safe-area-inset-left: 47px; --safe-area-inset-right: 47px; }');
    const { host, hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(932, 430);

    // POSITIVE CONTROL on the injection itself: a `[]`-shaped pass from properties that
    // never arrived is indistinguishable from one where they arrived and were ignored.
    expect(
      [
        getComputedStyle(host).getPropertyValue('--safe-area-inset-left').trim(),
        getComputedStyle(host).getPropertyValue('--safe-area-inset-right').trim(),
      ],
      'POSITIVE CONTROL FAILED: the injected display-cutout insets did not reach ' +
        '`app-page-content` at 932x430, so every assertion below would pass for the wrong ' +
        'reason — properties that never arrived cannot be spent either. Check `injectCss` and ' +
        "the harness's own `:root` extraction before reading the verdict."
    ).toEqual(['47px', '47px']);

    expect(
      hostWidth,
      `at 932x430 the app column is ${hostWidth}px inside a ${parentWidth}px parent while the ` +
        'display-cutout insets are 47px a side. Something in the chain has started SPENDING ' +
        'those insets on in-flow page content — a `margin-inline` or a bound derived from ' +
        'them, or (in THIS harness only) a `padding-inline`. ⚠️ READ THE PADDING ASSERTION ' +
        'BELOW BEFORE CONCLUDING THIS ONE COVERS PADDING: this harness is `content-box`, so a ' +
        'padding-based inset widens the box and fails HERE, but production is `border-box`, ' +
        'where the identical regression leaves this width correct and only the padding read ' +
        'catches it. The shell pays the TOP inset only, on purpose: paying ' +
        'left/right here would inset every full-page App Block by ~47px a side on a notched ' +
        'phone in landscape and nowhere else, which is the worst possible shape for a bug ' +
        'report. If that payment is deliberate, it belongs in the shell with its own test, not ' +
        "as a side effect on a third-party app's column."
    ).toBe(parentWidth);
    expect(
      [gutterLeft, gutterRight],
      `at 932x430 the app column is not flush with its parent: ${gutterLeft}px left, ` +
        `${gutterRight}px right. The width above can match while the box is SHIFTED, so both ` +
        'are read.'
    ).toEqual([0, 0]);

    const cs = getComputedStyle(host);
    expect(
      [cs.marginLeft, cs.marginRight],
      'at 932x430 the app column resolved a non-zero inline margin. Nothing declares one — ' +
        'the `margin-inline: auto` that used to centre a capped column was deleted with the ' +
        'cap — so a value here means it is coming from a stylesheet or a substituted component.'
    ).toEqual(['0px', '0px']);

    // 🔴 AND THE PADDING, WHICH IS THE HALF THE GEOMETRY ASSERTIONS ABOVE STRUCTURALLY CANNOT
    // SEE IN PRODUCTION. A review round measured `paddingInline: 'var(--safe-area-inset-left)'`
    // on this element: it failed the width assertion above with `1026px inside a 932px parent`
    // — but read the number, `1026 = 932 + 2×47`. The padding landed OUTSIDE the 100% width,
    // i.e. THIS HARNESS IS `content-box`, because `test/component-setup.tsx` injects only
    // `:root` custom properties and never loads `@tailwind base`. Production is `border-box`
    // (`globals.css`'s `@layer tailwind-preflight { @tailwind base; }`), where the identical
    // regression leaves `hostWidth === parentWidth`, both gutters 0 and both margins `0px` —
    // every assertion above green while the app is inset by 47px a side on a notched phone in
    // landscape and nowhere else.
    //
    // So the arm's title and message name three routes ("a `padding-inline`, a
    // `margin-inline` or a bound") and the geometry assertions covered two of them in
    // production terms. This reads the padding DIRECTLY, which is box-model-independent and
    // therefore says the same thing in both environments. ⚠️ It is the one assertion in this
    // arm whose result does NOT depend on the harness's box model — do not "simplify" it into
    // the width comparison above, which is exactly where the blind spot was.
    //
    // 🔴 AND IT IS REACHABLE, WHICH TOOK A SECOND MUTANT TO SHOW — the naive one does not
    // reach it. Measured both ways. (a) `paddingInline: 'var(--safe-area-inset-left)'` alone:
    // the WIDTH assertion above fires first (`1026px inside a 932px parent`) and this line
    // never executes, so that mutant proves nothing about this assertion — the
    // earlier-check-always-wins shape, where a guard looks tested and is not. (b) The same
    // padding PLUS `boxSizing: 'border-box'`, i.e. the production shape: width stays 932, the
    // gutters stay 0, the margins stay `0px`, every geometry assertion passes, and THIS line
    // is the only one that fails. (b) is the control that matters, because (b) is what the
    // deployed cascade does.

    expect(
      [cs.paddingLeft, cs.paddingRight],
      'at 932x430 the app column has a non-zero inline PADDING while the display-cutout insets ' +
        "are 47px a side. Something is spending them on the third-party app's own column. " +
        'Read this assertion rather than the width one above: under production `border-box` a ' +
        "padding-based inset does NOT change the element's width, so the geometry assertions " +
        'above stay green through exactly this regression — they only catch it in this ' +
        'harness, which is `content-box` because it loads no Tailwind preflight.'
    ).toEqual(['0px', '0px']);
  });
});
