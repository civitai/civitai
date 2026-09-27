import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { cleanup } from 'vitest-browser-react';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
// Raw text, NOT a stylesheet import — the ledger's REAL rules are parsed out of
// this and injected. See `ledgerFromGlobals` for why that indirection exists.
import globalsCss from '~/styles/globals.css?raw';
// The ONE spelling of "which app does a `[data-block-id=…]` selector name", shared with
// the node-tier membership enumeration. It lived here as a private helper and was the
// only tolerant copy of four; promoting it is what closed a surviving mutant. See that
// module for the measured table.
import { blockIdsIn, TEMPLATE_RULE } from '../../../test/ledger-block-ids';
// Type-only namespace import for the `importOriginal` spread below (the repo's
// local-rules/no-wholesale-module-mock cure). NOT `typeof import(...)`, which
// @typescript-eslint/consistent-type-imports rejects.
import type * as TrpcMod from '~/utils/trpc';

/**
 * THE FULL-PAGE APP BLOCK IS UNCAPPED — MEASURED, at named viewports.
 *
 * THE CONTRACT. `/apps/run/<slug>` hands the app the viewport. Nothing in the chain
 * bounds it: the page wrapper is `width: '100%'`, the host root is `width: '100%'`, the
 * content wrapper is `width: '100%'` with `max-width: var(--app-page-max-width, none)`,
 * and the iframe is `width: '100%'`. An app that wants a centred column sets one in its
 * own CSS, inside its own iframe document.
 *
 * ⚠️ THIS FILE USED TO MEASURE THE OPPOSITE, AND THE INVERSION IS THE POINT. The host
 * capped a full-page app at 1600px and centred it past that, and these cases asserted
 * the cap bound at 2560 and 3440. The cap was dropped by an owner decision; the whole
 * record — including what the 1600 was worth and what it cost — lives on the
 * `--app-page-max-width` declaration in `src/styles/globals.css`. What is preserved here
 * is the SHAPE of the old suite, because it was the right shape: measure at named
 * viewports, pair every claim with a control, and keep the below-threshold arm as the
 * reference it always was.
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
 * that lives only in a PR description is not evidence anyone can re-read). Re-introducing
 * `--app-page-max-width: 1600px` on `:root` in `globals.css` — the exact value the old cap
 * used — takes this file to **6 failed | 11 passed at 17 arms**, and the 1620/1905/2560/3440
 * arms fail with THIS suite's own message ("the app column is 1600px inside a 1620px parent
 * — it is being capped, with 10px of gutter on the left"). The node-tier guard fails
 * separately with its own "`--app-page-max-width` … is no longer `none`".
 *
 * ⚠️ QUOTE THAT FIGURE WITH ITS ARM COUNT, BECAUSE IT WENT STALE ONCE ALREADY AND THAT IS
 * THE WHOLE HAZARD OF RECORDING A COUNT. It first read "5 failed | 8 passed" — 13 arms,
 * i.e. the count BEFORE the review round that added 1620/390/1366/1600 — so the recorded
 * run could not have seen the 1620 arm it named, and the ordinal below pointed at the wrong
 * test. A count is only readable against the arm total it was taken at.
 *
 * ⚠️ THE SIXTH failure is the NEGATIVE arm of the per-app-cap test, and it dies for a
 * DIFFERENT reason than its headline message describes — its message now names that
 * alternative cause explicitly, because a mutant that dies with a misdirecting message
 * sends the reader at the wrong mechanism.
 *
 * 🔴 SECOND MUTANT, AND THE ONE THAT WAS ACTUALLY SURVIVING. A review found that
 * `[data-app-page-frame][data-block-id*='sensei'] { --app-page-max-width: 1100px; }` — and,
 * a round later, the `[data-block-id='sensei' i]` flag form — capped an app in production
 * with 17/17 here and 17/17 across the two node guard files (10 + 7 at the time of writing —
 * quote a count with its arm total; this pair read 16/16 for one commit after an `it` was
 * added, which is the third instance of that in this segment). Both now die against the membership
 * enumeration with its own message (`expected [ 'sensei' ] to deeply equal []`), because the
 * predicate moved to one shared `test/ledger-block-ids.ts`. Neither is a width mutant, so
 * NO arm in this file catches them — that is the node tier's job, and this note exists so
 * the split is not rediscovered.
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
 * re-cap every full-page App Block in production and be invisible here (never injected)
 * AND invisible to the node guard (every pattern there greps `--app-page-max-width`; a bare
 * `max-width:` is not searched). That is pre-existing harness blindness, not something this
 * change introduced — but with the default at `none` the ONLY rendered evidence that no cap
 * exists comes from a cascade this suite builds itself, so the blind spot is now the
 * cheapest way to reintroduce a cap unnoticed.
 *
 * ⚠️ THE FIRST VERSION OF THIS NOTE JUSTIFIED LEAVING IT UNGATED WITH "zero instances in this
 * file's history", WHICH IS THE WRONG DENOMINATOR AND CONTRADICTED THE SENTENCE BEFORE IT: if
 * the uncap makes this the cheapest way to reintroduce a cap, the base rate just changed and
 * history cannot price it. The narrow half is now GATED in the node tier —
 * `src/components/AppBlocks/__tests__/pageBlockHostMaxWidth.test.ts` has a
 * `no bare max-width rule targets the app host box` assertion that greps `globals.css` for a
 * `max-width` declaration under any selector naming the host's own markers, with a synthetic
 * positive control. What stays ungated is the WIDE half — a cap arriving from any other
 * stylesheet, or via the cascade this harness does not load — because closing that means
 * loading the real app cascade, which moves every other browser suite's geometry. Know that
 * before trusting a green run here.
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
 * The app slug the fixture runs as — also the key a PER-APP PLATFORM rule is written against.
 * (It said "an opt-out rule" until a review enumerated the property's mentions: there are no
 * opt-outs, because there is no default to opt out of. A rule keyed on this now IMPOSES a
 * width.)
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
 * `globals.css` with its block comments removed.
 *
 * The ledger's own doc comment contains a TEMPLATE rule (`'my-canvas-app'`), and
 * the entries discuss their own selectors in prose, so an id count taken over the
 * raw file counts things that do not ship. Same strip, for the same reason, as
 * `code()` in `__tests__/pageBlockHostMaxWidth.test.ts`. Block comments only —
 * CSS has no `//` comment, and stripping one would eat the rest of any line
 * holding a `url(https://…)`.
 */
function cssWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The REAL per-app width rules, parsed out of `globals.css` itself. There are none today
 * — the ledger is deliberately empty — so this returns `{css: '', ids: []}`, and the
 * caller's job is to say what that empty result is and is not evidence for.
 *
 * ⚠️ THIS USED TO BE NAMED FOR, AND DESCRIBED AS, THE "full-bleed opt-out" RULES. Those
 * were rules excusing an app from a 1600px default; with the default at `none` a rule here
 * would CAP one app instead. Same selector shape, same inheritance path, opposite
 * direction — and no live instances, so nothing below may presuppose one exists.
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
 * suite has always had while making the assertions depend on the shipped text. ⚠️ With
 * the ledger empty that dependency is latent rather than active: there is no real entry to
 * delete or mistype today, so what this buys is that the FIRST entry anyone adds is
 * measured on the day its rule lands.
 *
 * 🔴 THE BROWSER PARSES IT, NOT A REGEX — the same decision, for the same reason,
 * that `component-setup.tsx` records at length: three successive regex extractors
 * there each shipped a defect (a comment glued to the next property, a `}` inside
 * a string truncating the capture), because several regexes cannot agree on where
 * a CSS block ends. `replaceSync` hands that to the engine that will evaluate it.
 *
 * ⚠️ WHAT THE WALK DOES NOT REACH, AND WHY THAT IS CHECKED RATHER THAN TRUSTED. It
 * descends through `@layer` blocks and nothing else — not `@media`, `@supports` or
 * `@container` — because a rule inside a conditional at-rule cannot be injected
 * unconditionally without changing what it means. That is a deliberate limit, and
 * it is also a HOLE: a member whose rule moves into such a block disappears from
 * `ids`, the derived green arm never measures it, and the test still passes on the
 * remaining members. So the caller asserts these `ids` EQUAL the ids in the raw
 * file text — see the assertion in the LEDGER case, which is the only thing
 * standing between that limit and a silently unmeasured member.
 */
function ledgerRulesIn(source: string): { css: string; ids: string[] } {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(source);
  const css: string[] = [];
  const ids: string[] = [];
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        if (!rule.selectorText.includes('data-block-id')) continue;
        css.push(rule.cssText);
        ids.push(...blockIdsIn(rule.selectorText));
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        walk(rule.cssRules);
      }
    }
  };
  walk(sheet.cssRules);
  return { css: css.join('\n'), ids };
}

/** `ledgerRulesIn` over the shipped stylesheet — the population under test. */
function ledgerFromGlobals(): { css: string; ids: string[] } {
  return ledgerRulesIn(globalsCss);
}

/**
 * 🔴 POSITIVE CONTROL ON THE CSSOM WALK — CAN IT SEE A RULE AT ALL?
 *
 * The shipped ledger is EMPTY, so `ledgerFromGlobals().ids` is legitimately `[]` and the
 * old `not.toHaveLength(0)` floor had to go. A `[]` from a walk that reaches nothing looks
 * identical, so the floor is replaced by this: feed the walk a rule it MUST find, and
 * report the pair — 1 on the control, 0 under test. Synthetic on purpose, so it cannot go
 * green for the same reason the population under test did.
 */
function cssomWalkPositiveControl(): void {
  const probe = ledgerRulesIn(
    `@layer x { [data-app-page-frame][data-block-id='control-app'] { --app-page-max-width: 123px; } }`
  );
  expect(
    probe.ids,
    'POSITIVE CONTROL FAILED: the CSSOM walk did not find a synthetic, correctly-shaped per-app ' +
      'rule (inside an `@layer`, which is the one at-rule it descends into). It can therefore see ' +
      'nothing, and the empty result it reports for globals.css carries no information at all. ' +
      'Fix the walk before reading any verdict below.'
  ).toEqual(['control-app']);
  expect(
    probe.css,
    'POSITIVE CONTROL FAILED: the CSSOM walk found the synthetic rule but returned no CSS text ' +
      'for it, so the injected-cascade arm below would inject nothing.'
  ).toContain('--app-page-max-width');
}

/**
 * The px value the "HOW TO ADD ONE" template in `globals.css` teaches, read out of that
 * file's COMMENTS.
 *
 * 🔴 DERIVED, NOT RESTATED, AND THE REASON IS A FALSE PREMISE THIS FILE SHIPPED. Two tests
 * below reason ABOUT the template's value — the per-app arm calls itself "the value the
 * template shows", and the safe-area invariant's failure message says *"Either the template
 * value in globals.css dropped below ~1000px"*. Both hardcoded `1100` and neither read the
 * template, so lowering the template to `900px` would leave both green while the sentence
 * explaining why they are green became false. The number also existed in four places
 * (the template, the publisher doc, and twice here) with nothing binding them.
 *
 * FAILS LOUD on a parse miss rather than defaulting: a silent fallback would restore exactly
 * the disconnect this replaces. The regex deliberately matches the template's SHAPE rather
 * than its placeholder slug, so renaming `my-canvas-app` does not break it.
 *
 * ⚠️ EXPECT THIS TO FAIL WHEN THIS FILE IS RUN AGAINST THE PRE-UNCAP IMPLEMENTATION, and read
 * that as correct rather than as a broken parse. On the base revision the template taught
 * `--app-page-max-width: none` — it was an opt-OUT recipe, not a cap recipe — so there is no
 * px value to derive and the two tests that call this are meaningless there. Only the
 * 1620/1905/2560/3440 arms and the chrome/app pair are the red-at-base evidence for the
 * uncap; these two are about the mechanism's SURVIVING direction, which exists only at HEAD.
 */
function templateCapPxFromGlobals(): number {
  // 🔴 COMMENT TEXT ONLY, AND THE DOCBLOCK USED TO CLAIM THIS WHILE THE CODE DID NOT. An
  // earlier version `.exec`d the WHOLE raw stylesheet and took the FIRST match, which is the
  // template only by accident of file ORDER. Measured: with a shipped rule at 800px above the
  // template, it returned 800 — so on the first day the ledger gains an entry, the safe-area
  // invariant would fail with "the template now teaches 800px" and blame the template for a
  // shipped rule's value. That is the misattribution class this suite fixes twice elsewhere.
  const comments = [...globalsCss.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0]).join('\n');
  // 🔴 EXACTLY ONE MATCH, NOT THE FIRST. `region()` in the node guard exists for precisely
  // this ("more than one means the pin has become ambiguous and is grading an arbitrary
  // occurrence") and its lesson had not crossed the tier boundary. A second worked example in
  // the comments must be a deliberate edit here, not a silent re-point.
  // `TEMPLATE_RULE` is deliberately NOT `/g` (so no caller inherits another's `lastIndex`),
  // and `matchAll` requires a global regex — build one from its source, which is what the
  // module's docblock tells callers that need every match to do.
  const all = [...comments.matchAll(new RegExp(TEMPLATE_RULE.source, 'g'))];
  expect(
    all.length,
    `expected exactly ONE worked per-app width template in the COMMENTS of src/styles/globals.css, found ${all.length}. ` +
      'It is the shape a future platform cap gets copied from, and two tests below derive ' +
      'their cap value from it so their stated reasoning is checkable. ZERO means the template ' +
      'was removed or its formatting moved past this parse (re-point those tests deliberately); ' +
      'MORE THAN ONE means this parse is grading an arbitrary occurrence.'
  ).toBe(1);
  return Number(all[0][1]);
}

/**
 * The production chain, reduced to what decides WIDTH.
 *
 * Mirrors `src/pages/apps/run/[slug]/[[...path]].tsx`: `AppLayout`'s no-scroll
 * `<main>` (a full-width flex column) and the run page's own wrapper Box. Both
 * are `width: 100%` with no bound of their own, and so is the host — the platform
 * imposes no width anywhere in this chain.
 *
 * ⚠️ THE PREVIOUS SENTENCE HERE SAID THIS WAS "the reason the cap has to be on the host",
 * which was a present-tense claim that a cap must exist. Retracted: it described the
 * reasoning behind a 1600px default that no longer ships. What the chain is still evidence
 * for is that NOTHING here would bound an app if the host did not — which is why a per-app
 * platform rule, if one is ever wanted, has to be read on the host and nowhere else.
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
  //   · `app-page-content` — the app's own column (iframe or failure card). This is the
  //                          box that READS `--app-page-max-width`, so it is the one a
  //                          per-app platform rule would bound. Nothing bounds it today.
  // `hostWidth` therefore reads the CONTENT box: every width claim below is about the app
  // column, and pointing it at the frame would make them assert something else entirely.
  // `frameWidth` is measured alongside so the full-bleed half can be asserted rather than
  // assumed. ⚠️ This comment used to read "This is what the ultrawide cap binds" and
  // "every capped/centred claim below" — both present tense, both false now that the
  // default is `none`: exactly ONE arm below is a capped claim, and it injects the rule
  // that makes it one.
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
        'something is capping the app. The platform imposes no width: `--app-page-max-width` is ' +
        '`none` in globals.css and the host’s `var()` fallback is `none` too. Either that ' +
        'default moved, or a per-app rule in the (meant-to-be-empty) width-cap ledger is matching ' +
        `this fixture’s slug '${BLOCK_ID}'.`
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
          'full-page App Block: `--app-page-max-width` is declared `none` on `:root` in ' +
          'src/styles/globals.css and the host reads it as ' +
          '`max-width: var(--app-page-max-width, none)`. READ THE ARM THAT FAILED: a bound ' +
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

      const cs = getComputedStyle(host);
      expect(
        [cs.marginLeft, cs.marginRight],
        `at ${w}x${h} the auto margins resolved non-zero`
      ).toEqual(['0px', '0px']);
    }
  );

  /**
   * 🔴 PROVE THE WIDTH COMES FROM THE CUSTOM PROPERTY, NOT FROM A LITERAL IN THE
   * COMPONENT. The per-app mechanism rests entirely on the host reading
   * `--app-page-max-width` through `var()` — if someone "simplified" it to an inline
   * number, or wrote the property inline on the host (where it would beat every
   * stylesheet rule), every arm above would still pass and the documented lever would be
   * silently inert.
   *
   * ⚠️ AND WITH THE DEFAULT AT `none` THIS IS THE ONLY RENDERED TEST THAT CAN SEE THE
   * MECHANISM AT ALL. An uncapped host renders identically whether the `var()` is read or
   * deleted, so the arms above cannot distinguish "reads the property" from "has no
   * max-width". This drives the property to a value no implementation would pick and
   * checks the rendered width follows it exactly.
   */
  test('the width is read from `--app-page-max-width` — overriding it moves the rendered width', async () => {
    injectCss(':root { --app-page-max-width: 900px; }');
    const { hostWidth } = await mountAt(2560, 1080);
    expect(
      hostWidth,
      'the host did not follow a `--app-page-max-width: 900px` override at 2560x1080 — the ' +
        'width is not actually being read from the custom property, so no per-app rule can work ' +
        'and the escape hatch documented in globals.css is inert'
    ).toBe(900);
  });

  /**
   * 🔴 THE MECHANISM STILL WORKS IN THE CAPPING DIRECTION — the arm that keeps the
   * documented per-app lever honest now that nothing uses it.
   *
   * ⚠️ THIS IS THE INVERSE OF THE TEST IT REPLACED. That one injected
   * `--app-page-max-width: none` for the fixture's slug and asserted the app went back to
   * FULL width, escaping a 1600px default. With the default already `none` that assertion
   * is vacuous — it would pass with the rule deleted, with the selector mistyped, and on
   * the pre-cap base revision. So the rule injected here sets a px value and the assertion
   * is that the app becomes a CAPPED, CENTRED column. Same selector shape, same
   * inheritance path (property set on the frame, read on the content wrapper), opposite
   * direction.
   *
   * PAIRED WITH A NEGATIVE ARM in the same cascade: a DIFFERENT slug, same injected rule,
   * must stay full width. Without it, "the app is 1100px" is equally satisfied by a bound
   * that applies to every app.
   *
   * 🔴 WHAT A GREEN RUN HERE IS **NOT** EVIDENCE FOR: that such a selector works on
   * civitai.com. Vitest never runs with `NODE_ENV=production`, so the
   * `reactRemoveProperties` strip in `next.config.mjs` never applies in this tier — which
   * is exactly how the `data-testid` spelling shipped broken with this suite passing
   * throughout. That claim is owned by
   * `src/components/AppBlocks/__tests__/ledgerSelectorSurvivesProdStrip.test.ts`, which
   * compares the two CONFIGURATIONS instead of rendering, and it cannot be moved here.
   */
  test('a per-app platform rule CAN still cap one app — and only that app', async () => {
    // The value the "HOW TO ADD ONE" template in globals.css shows, READ FROM THAT FILE —
    // so the number this test exercises is the number a maintainer would actually copy, and
    // a change to the template cannot leave this test asserting a value nobody teaches.
    const CAP = templateCapPxFromGlobals();
    injectCss(
      `[data-app-page-frame][data-block-id='${BLOCK_ID}'] { --app-page-max-width: ${CAP}px; }`
    );

    const capped = await mountAt(2560, 1080, { blockId: BLOCK_ID });
    expect(
      capped.hostWidth,
      `at 2560x1080 the app '${BLOCK_ID}' did not take a ${CAP}px per-app cap written in the ` +
        'shape the globals.css template teaches. Either `data-app-page-frame`/`data-block-id` are ' +
        'no longer stamped together on the host root, or the width is no longer read through ' +
        '`var()` on a descendant of that element — and the one documented way for the platform ' +
        'to set a single app’s width is inert.'
    ).toBe(CAP);
    expect(
      Math.abs(capped.gutterLeft - capped.gutterRight),
      `at 2560x1080 the capped app is not centred: ${capped.gutterLeft}px left vs ` +
        `${capped.gutterRight}px right. \`margin-inline: auto\` is missing or overridden — a cap ` +
        'without it dumps the whole gutter on one side and reads as a rendering bug.'
    ).toBeLessThanOrEqual(1);

    // Each arm mounts its own tree, so the previous one has to go: two mounted
    // `app-page-frame` nodes would fail every `getByTestId` on the strict-mode
    // single-match rule.
    await cleanup();

    // NEGATIVE ARM — a different slug, the SAME cascade, still full width. This is what
    // distinguishes "the per-app rule works" from "something caps every app".
    const other = await mountAt(2560, 1080, { blockId: 'some-other-app' });
    expect(
      other.hostWidth,
      `the app 'some-other-app' is ${other.hostWidth}px inside a ${other.parentWidth}px parent, ` +
        'i.e. something capped an app this test injected NO rule for. TWO CAUSES, AND THIS ' +
        'ASSERTION CANNOT TELL THEM APART — read both before concluding: (a) the per-app ' +
        'selector is over-matching, i.e. it is keyed on something every host carries rather ' +
        'than on `data-block-id`; or (b) THE `:root` DEFAULT IS NO LONGER `none`, in which ' +
        'case nothing is wrong with the selector at all and the real failure is the platform ' +
        'imposing a width again. (b) is not hypothetical: it is what the recorded mutation ' +
        'control does, and this arm was the one failure in that run whose headline message ' +
        'named the wrong mechanism. If the other arms in this file are also red, it is (b).'
    ).toBe(other.parentWidth);
  });

  /**
   * 🔴 THE SHIPPED LEDGER IS EMPTY, AND WHAT IS PINNED IS THE WALK'S REACH, NOT A COUNT.
   *
   * ⚠️ THIS TEST USED TO MOUNT EVERY LEDGER MEMBER. It derived its green arms from the
   * rules parsed out of `globals.css` so a future entry would be covered the day its rule
   * landed. There are no members now — the 1600px default they were excused from is gone —
   * so the derived loop iterates nothing, and the test is kept for the one claim it can
   * still make and no other tier can: that the CSSOM walk REACHES the same set of rules
   * the file textually contains.
   *
   * WHY THAT RELATIONSHIP IS WORTH A TEST WITH AN EMPTY LEDGER. It is the only check in
   * the repo that CAN tell a REACHABLE rule from a WRITTEN one — future tense, deliberately:
   * over an empty ledger the equality is `[] === []` and constrains nothing, so the only
   * LIVE claim in this test today is its positive control. It is kept for the day the first
   * rule lands. Measured, before the
   * uncap: wrapping the `sensei` rule in `@media (min-width: 3000px)` — a plausible "only
   * above the cap" refinement with a wrong bound — left this file 11/11 and the two
   * node-tier guard files 16/16 while sensei rendered capped at 1600 on a 2560 display.
   * Neither node-tier guard can see it (both are text-based; the id is still present in
   * the text). The same hole would swallow the FIRST rule anyone adds here, and this
   * assertion is what catches it on day one rather than after a bug report.
   *
   * Both sides are derived from the same shipped file and no membership is restated, so
   * this cannot rot into a stale list. The ENUMERATION that fails on growth and shrink
   * lives in `__tests__/pageBlockHostMaxWidth.test.ts`; these are different claims and
   * neither tier can make the other's.
   */
  test('every per-app rule in globals.css is REACHABLE by the CSSOM walk — none hidden in an at-rule', async () => {
    // The pair, in this order: prove the walk can see a rule, then report what it sees in
    // the shipped file. That is legitimately `[]` today, and a `[]` from a walk that
    // reaches nothing would look identical.
    cssomWalkPositiveControl();
    const ledger = ledgerFromGlobals();

    // 🔴 AND CONTROL THE OTHER OPERAND'S PIPELINE, NOT JUST THE WALK'S. The equality below
    // compares the walk against `blockIdsIn(cssWithoutComments(globalsCss))`, and
    // `cssWithoutComments` had no control at all: degrade it toward returning `''` and the
    // right-hand side is `[]`, which with an empty ledger matches the left-hand side and the
    // assertion holds. A control that skips a step IN the pipeline under test is not a
    // control of that pipeline. So the same synthetic probe goes through the full
    // right-hand-side path — including the stripper — and must survive it.
    const rhsProbe = `[data-app-page-frame][data-block-id='control-app'] { --app-page-max-width: 123px; }`;
    expect(
      blockIdsIn(cssWithoutComments(rhsProbe)),
      'POSITIVE CONTROL FAILED on the EXPECTED side of the equality below: ' +
        '`blockIdsIn(cssWithoutComments(…))` did not survive a synthetic rule. Most likely ' +
        '`cssWithoutComments` is over-stripping — which would make the expected side `[]`, ' +
        'matching an empty walk, and the assertion would hold while measuring nothing.'
    ).toEqual(['control-app']);
    expect(
      blockIdsIn(cssWithoutComments(`/* ${rhsProbe} */`)),
      'POSITIVE CONTROL FAILED the other way: `cssWithoutComments` did not remove a rule that ' +
        'was inside a comment, so the "HOW TO ADD ONE" template in globals.css would be counted ' +
        'as a shipped member and this test would demand it render.'
    ).toEqual([]);

    expect(
      [...ledger.ids].sort(),
      'the CSSOM walk over src/styles/globals.css did not reach the same set of ' +
        '`[data-block-id=…]` rules that the file textually contains. RECEIVED is what ' +
        '`ledgerFromGlobals` could reach by walking the parsed stylesheet; EXPECTED is every id ' +
        'in the file with comments stripped. An id MISSING from the walk means its rule now sits ' +
        'inside an at-rule the walk does not descend into — `@media`, `@supports`, `@container`, ' +
        'anything but `@layer` — so it is written but not unconditionally reachable, and the app ' +
        'it names silently takes the default at every width the at-rule excludes. Fix it by ' +
        'moving the rule back to the top level (or into a `@layer`), or by teaching ' +
        '`ledgerRulesIn` to descend into that at-rule AND mounting a green arm at a viewport its ' +
        'condition admits — not by relaxing this assertion. An EXTRA id in the walk is the ' +
        'mirror case, and since BOTH sides now call the same shared `blockIdsIn` it can ' +
        'no longer mean "the raw parse missed a spelling the engine accepts" (that wording was ' +
        'true only while the two sides used different regexes): the remaining cause is ' +
        '`cssWithoutComments` over-stripping and deleting a rule the CSSOM kept, which is what ' +
        'the two controls above defend.'
    ).toEqual(blockIdsIn(cssWithoutComments(globalsCss)));

    // …and if a rule ever DOES ship, it must really render. Derived, so a future entry is
    // covered the day its rule lands rather than the day somebody remembers this file.
    // Iterates nothing today, which is why the assertion above is what this test is for.
    if (ledger.ids.length > 0) {
      injectCss(ledger.css);
      for (const blockId of ledger.ids) {
        const member = await mountAt(2560, 1080, { blockId });
        expect(
          member.hostWidth,
          `at 2560x1080 the per-app rule for '${blockId}' in src/styles/globals.css changed ` +
            'nothing about the rendered width. It is mistyped, or no longer overrides ' +
            '`--app-page-max-width` — so a rule that was reviewed and merged is doing nothing, ' +
            'with nothing about the page looking wrong.'
        ).not.toBe(member.parentWidth);
        await cleanup();
      }
    }
  });

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — labelled so it is never counted as proof
   * that anything here works.
   *
   * The claim it pins is about the SAFE-AREA insets, which went live with
   * `viewport-fit=cover`: in landscape on a notched device
   * `--safe-area-inset-left`/`-right` are ~47px, and the shell pays only the TOP inset
   * globally (`#__next { padding-top: … }` in globals.css), so left/right are unpaid for
   * in-flow page content. The question is whether a centring gutter can interact with
   * them — i.e. whether a viewport can be BOTH narrower than a cap and carrying a
   * non-zero inline inset.
   *
   * ⚠️ RE-POINTED, BECAUSE THE DEFAULT CAP THAT USED TO ANSWER IT IS GONE. It used to
   * assert the 1600px DEFAULT was inert at 932x430, which with a default of `none` is
   * trivially true and says nothing — it would be a guard that passes because its subject
   * no longer exists. So it now injects a per-app cap at the value the globals.css template
   * teaches ALONGSIDE the insets, and asserts that even THEN the app is flush: the widest
   * notched device in landscape is ~1000 CSS px, below that value, so the two mechanisms
   * still never meet. Pinned rather than asserted in prose because "no device does both" is
   * exactly the kind of claim that goes stale silently.
   *
   * 🔴 AND THE INJECTED RULE IS PROVEN LIVE BEFORE IT IS PROVEN INERT — otherwise this test
   * cannot distinguish "the cap is inert at this width" from "the selector matched nothing",
   * which a mistyped attribute, a renamed marker or a relocated `data-block-id` all produce.
   * Both give `hostWidth === parentWidth`. The title claims a RELATIONSHIP ("even a per-app
   * cap is inert"), so the body has to inspect both sides: the computed custom property on
   * the content box shows the rule reached it, and the geometry shows it changed nothing.
   *
   * ⚠️ THE MARGIN HERE IS NOW ~100px, NOT ~600. Under the old 1600px default the gap between
   * the widest notched-landscape viewport (~1000) and the binding width was ~600px; against
   * the template's value it is much tighter, so a template edit really can bring the two
   * mechanisms into contact — which is precisely why the value is derived from the file
   * rather than restated here, and why this test is the one that would notice.
   */
  // ⚠️ THE TITLE CARRIES NO NUMBER ON PURPOSE. It used to say "even a 1100px per-app cap",
  // which re-created in the TITLE the exact restatement `templateCapPxFromGlobals` was written
  // to remove — and the title is the string a reader sees in the run output and in a CI
  // annotation, which for most readers is the only string they see. The derived value appears
  // in the messages, where it is read from the file.
  test('INVARIANT — at a notched phone landscape size (932x430) even the template’s per-app cap is inert, so it cannot fight the safe-area insets', async () => {
    const CAP = templateCapPxFromGlobals();
    expect(
      CAP,
      `the per-app width template in globals.css now teaches ${CAP}px, which is at or below the ` +
        'widest notched device in landscape (~1000 CSS px). This test asserts that such a cap ' +
        'is INERT where the display-cutout insets are non-zero, and at this value it would no ' +
        'longer be — the gutter and the insets would have to be reasoned about together. That ' +
        'is a real finding about the template, not a test to relax.'
    ).toBeGreaterThan(1000);

    injectCss(
      ':root { --safe-area-inset-left: 47px; --safe-area-inset-right: 47px; }\n' +
        `[data-app-page-frame][data-block-id='${BLOCK_ID}'] { --app-page-max-width: ${CAP}px; }`
    );
    const { host, hostWidth, parentWidth, gutterLeft, gutterRight } = await mountAt(932, 430);

    // The rule REACHED the box — without this the assertions below are equally satisfied by
    // a selector that matched nothing, which is the vacuity the re-point was made to avoid.
    expect(
      getComputedStyle(host).getPropertyValue('--app-page-max-width').trim(),
      'the injected per-app rule did not reach `app-page-content` at 932x430, so the ' +
        '"and it is inert" assertions below would pass for the wrong reason — a selector that ' +
        'matches nothing is inert too. Check `data-app-page-frame` and `data-block-id` are ' +
        'still stamped together on the host root.'
    ).toBe(`${CAP}px`);
    expect(
      hostWidth,
      `at 932x430 the app column is ${hostWidth}px inside a ${parentWidth}px parent, i.e. the ` +
        `template's ${CAP}px cap has started binding at a viewport where the display-cutout ` +
        'insets are non-zero. The gutter and the insets would then have to be reasoned about ' +
        'together. Since the value is read from globals.css and separately asserted above to ' +
        'be >1000, reaching this line means the notched-landscape viewport class got wider ' +
        'than this fixture assumes.'
    ).toBe(parentWidth);
    expect([gutterLeft, gutterRight], 'at 932x430 the host is no longer flush').toEqual([0, 0]);
  });
});
