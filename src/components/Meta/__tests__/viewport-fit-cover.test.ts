import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../../../../test/strip-comments';
import { VIEWPORT_META_CONTENT } from '~/shared/constants/app-layout.constants';

/**
 * The app must ship `viewport-fit=cover` in its ONE `<meta name="viewport">`.
 *
 * Node `unit` project — the GATING suite. The `.browser.test.tsx` component
 * suites run in CI only as the report-only `preview / component-tests` status,
 * and that tier is red on `main` independently of anything here, so a coupling
 * that must not silently revert is pinned in this tier.
 *
 * WHAT WAS BROKEN. The meta content was `initial-scale=1, width=device-width`.
 * Absent a `viewport-fit` token the UA defaults to `auto`, which lays the page
 * out inside the safe area and therefore reports `0px` for every
 * `env(safe-area-inset-*)`. That made the codebase's only inset call site --
 * `ReviewActionBar`'s sticky bar, paying
 * `max(var(--mantine-spacing-md), env(safe-area-inset-bottom))` -- unable to
 * resolve to anything but its own fallback, on every device, forever. It read
 * as safe-area-aware and was inert.
 *
 * 🔴 WHY THIS ASSERTS THE WHOLE STRING RATHER THAN `toContain('viewport-fit')`.
 * A substring match is satisfied by a wrong string that happens to carry the
 * fragment -- `viewport-fit=auto` contains `viewport-fit`, and
 * `width=device-width, viewport-fit=cover` with `initial-scale` dropped still
 * contains both halves anyone would think to grep for. The whole normalised
 * value is the only assertion that cannot be walked around by rewording, and
 * the cost is that a deliberate change to the viewport string fails here and
 * has to be re-declared. That is the intended price.
 *
 * 🔴 WHAT THIS FILE CANNOT SEE. It reads source. It proves the string the app
 * renders, and (below) that no second viewport meta exists to override it. It
 * proves NOTHING about a physical device: that the insets actually come back
 * non-zero, that content clears the notch or the home indicator, or that the
 * padding added alongside this change is the right SIZE, are all observable
 * only on real hardware or a simulator. No test in this repo has observed
 * them.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SRC = path.join(REPO_ROOT, 'src');
const META_PWA = path.join(REPO_ROOT, 'src/components/Meta/MetaPWA.tsx');
const GLOBALS_CSS = path.join(REPO_ROOT, 'src/styles/globals.css');

const INSET_EDGES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Every file that pays a display-cutout inset back, as of this change.
 *
 * 🔴 THIS IS A LEDGER, AND IT FAILS IN BOTH DIRECTIONS ON PURPOSE. Shrinking
 * means an element that was compensating stopped — the regression this whole PR
 * exists to prevent, and it would otherwise be invisible because nothing about
 * a missing `padding-bottom` looks broken in a diff. Growing means someone
 * added a call site without it being reviewed as part of the edge-anchored set;
 * that is not wrong, it just has to be added here deliberately.
 *
 * 🔴 IT IS NOT A CLAIM THAT THIS SET IS COMPLETE, AND IT IS NOT THE WHOLE
 * MECHANISM ANY MORE. Two chokepoints now pay for whole POPULATIONS rather than
 * for a named file, and neither can appear in this list because both live in
 * `globals.css`, which the sweep below deliberately skips as the one legal
 * declaration site:
 *
 *   · `#__next { padding-top: … }` — every in-flow descendant, on every route,
 *     including the two that render their own chrome at the top edge.
 *   · the `@layer mantine` block — every `Drawer` and every `fullScreen`
 *     `Modal`, present and future, none of which is visible from `src/` at all.
 *
 * Those are pinned separately, as whole declarations, by
 * `the chokepoints that pay for whole populations` below. A file leaving THIS
 * list is still a regression; a file never joining it is no longer evidence
 * that its surface is unpaid.
 *
 * Elements deliberately left out, with reasons, are in the PR description.
 */
const INSET_CONSUMERS = [
  'src/components/Ads/AdhesiveAd.tsx',
  'src/components/AppLayout/AppFooter.tsx',
  'src/components/Apps/ReviewActionBar.tsx',
  'src/components/Chat/ChatPortal.tsx',
  'src/components/Consent/ConsentBanner.tsx',
  'src/components/Csam/CsamImageSelection.tsx',
  'src/components/Games/NewOrder/NewOrderImageRatings.tsx',
  'src/components/ImageGeneration/GeneratedOutputLightbox.tsx',
  'src/components/IterativeEditor/IterativeImageEditor.module.scss',
  'src/components/Sticker/StickerPlacementTray.tsx',
  'src/components/generation_v2/GenerationLayout.tsx',
  'src/pages/comics/project/[id]/ProjectWorkspace.module.scss',
  'src/providers/ThemeProvider.tsx',
];

const repoPath = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

/**
 * A test file MEASURES the inset layer; it never PAYS an inset, so it belongs in
 * neither sweep below. `safeAreaInsets.browser.test.tsx` writes
 * `padding-bottom: var(--safe-area-inset-bottom)` into a string to read the
 * computed value back, and `stripComments` keeps strings (deliberately — the
 * viewport sweep's subject IS a string literal), so without this it lands in the
 * ledger as a twelfth "consumer". No production call site lives under
 * `__tests__`, so nothing real is hidden by this.
 */
const isTestFile = (file: string) =>
  /(^|\/)__tests__\//.test(repoPath(file)) || /\.test\./.test(file);

function read(file: string): string {
  // Prove the path before trusting a "no match": a comparison against an absent
  // operand reports SAME, not MISSING, so a renamed component would otherwise
  // turn every assertion below into a vacuous pass over an empty string.
  expect(fs.existsSync(file), `${repoPath(file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/**
 * The `{…}` starting at `open`, braces balanced. A depth counter rather than a
 * regex because the thing being read is a nested object literal, and `[^}]*` on
 * one of those stops at the FIRST inner close — which would silently truncate
 * `content: { … }` right before the padding it was looking for and report a
 * clean sweep. Returns '' if the braces never balance, so a malformed read is
 * empty rather than plausible.
 */
function braceMatched(src: string, open: number): string {
  if (open < 0 || src[open] !== '{') return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

function srcFiles(extensions: RegExp): string[] {
  const files = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => extensions.test(f))
    .map((f) => path.join(SRC, f))
    // `readdirSync` yields directories too, and this repo has directories whose
    // names end in a matching extension — reading one throws EISDIR.
    .filter((f) => fs.statSync(f).isFile());
  // Guard the walk itself: a glob matching nothing makes every sweep below
  // vacuously true, which is the reassuring-zero failure mode.
  expect(
    files.length,
    'the src/ walk matched no files — every sweep below is vacuous'
  ).toBeGreaterThan(1000);
  return files;
}

describe('the viewport meta opts into the full display area', () => {
  it('pins VIEWPORT_META_CONTENT as a whole normalised string', () => {
    // 🔴 The literal is written out here, NOT derived from the constant or from
    // any parse of it. Deriving it would grade the constant against itself and
    // could not fail.
    expect(
      VIEWPORT_META_CONTENT,
      'the viewport meta content changed. If that is deliberate, re-declare the whole string ' +
        'here — and check that `viewport-fit=cover` survived, because dropping it silently ' +
        're-zeroes every env(safe-area-inset-*) in the repo.'
    ).toBe('initial-scale=1, width=device-width, viewport-fit=cover');
  });

  it('parses to exactly the expected directive set, with viewport-fit=cover', () => {
    // The string assertion above is order- and whitespace-sensitive by design.
    // This one restates the claim as SEMANTICS, so a reviewer reading a failure
    // can tell "reformatted" from "a directive changed meaning".
    const directives = Object.fromEntries(
      VIEWPORT_META_CONTENT.split(',').map((part) => {
        const [key, value] = part.split('=');
        return [key.trim(), (value ?? '').trim()];
      })
    );
    expect(directives).toEqual({
      'initial-scale': '1',
      width: 'device-width',
      'viewport-fit': 'cover',
    });
  });

  it('MetaPWA renders the viewport meta from the constant, not a copy of the string', () => {
    // The seam, not either side of it. A constant with the right value and a tag
    // carrying a hardcoded literal would satisfy the value assertion above while
    // shipping whatever the literal says.
    const src = stripComments(read(META_PWA));
    expect(
      src,
      '`MetaPWA` no longer renders <meta name="viewport" content={VIEWPORT_META_CONTENT} />. ' +
        'If the tag was inlined back to a string literal, the constant and the shipped value ' +
        'can now disagree and the assertions above stop describing the app.'
    ).toMatch(/<meta\s+name="viewport"\s+content=\{VIEWPORT_META_CONTENT\}\s*\/>/);
  });

  it('declares exactly one viewport meta in the app document, in MetaPWA', () => {
    // A second viewport meta rendered into the SAME document would be merged or
    // would win by document order, so the whole-string pin above would stop
    // being a claim about what the browser reads. This is a directory walk
    // rather than a hand-kept list so a new one is noticed wherever it lands —
    // the walk found the exemption below on its first run, which is the positive
    // control that it can see a declaration outside MetaPWA at all.
    const declarations: string[] = [];
    for (const file of srcFiles(/\.(ts|tsx)$/)) {
      if (path.resolve(file) === path.resolve(__filename)) continue;
      // Its own standalone `<!doctype html>` document, served directly by the
      // auth routes and never mounted inside `_app`, so it cannot override
      // MetaPWA's tag. It is deliberately left at the default `viewport-fit=auto`:
      // it centres a single card with `place-items: center` and has no
      // edge-anchored chrome, so opting it into the display cutout would push its
      // text under the notch and buy nothing.
      if (repoPath(file) === 'src/server/auth/login-error-page.ts') continue;
      // Comments only — strings are the subject here, so stripping them would
      // remove the very thing being looked for.
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      // One entry PER MATCH, not per file: two viewport metas in one component is
      // as much of a break as two across files, and a per-file `if` would hide it.
      const matches = src.match(/name=(?:"viewport"|'viewport'|\{['"]viewport['"]\})/g) ?? [];
      declarations.push(...matches.map(() => repoPath(file)));
    }
    expect(
      declarations,
      'expected exactly ONE `name="viewport"` meta in the app document. Zero means MetaPWA was ' +
        'renamed or the tag removed — re-point this guard rather than deleting it. More than one ' +
        'means a second viewport meta can override the one this file pins; if the new one belongs ' +
        'to its own standalone document, exempt it BY PATH above with the reason.'
    ).toEqual(['src/components/Meta/MetaPWA.tsx']);
  });
});

describe('the safe-area custom-property layer', () => {
  it('declares all four insets on :root, each with an env() fallback', () => {
    const css = read(GLOBALS_CSS);
    for (const edge of INSET_EDGES) {
      // 🔴 The `, 0px` is the assertion, not decoration. `padding: env(x)` in a UA
      // that does not know `x` is INVALID AT COMPUTED-VALUE TIME — the declaration
      // is dropped, so the element loses the padding it had rather than keeping
      // it. Writing the fallback once here is the only reason a call site can say
      // `var(--safe-area-inset-bottom)` and be safe.
      expect(
        css,
        `globals.css must declare --safe-area-inset-${edge} with an env() fallback of 0px. ` +
          "Without the fallback, every consumer's whole declaration is dropped in a UA that " +
          'does not support the variable — it does NOT fall back to the previous padding.'
      ).toContain(`--safe-area-inset-${edge}: env(safe-area-inset-${edge}, 0px);`);
    }
  });

  it('routes every consumer through the custom property, never a bare env()', () => {
    // One rule, one place. A call site that reaches for `env()` directly re-opens
    // the missing-fallback hole above, at that site only, and nothing else would
    // report it. globals.css is the single legal declaration site.
    const offenders: string[] = [];
    for (const file of srcFiles(/\.(css|scss|ts|tsx)$/)) {
      if (isTestFile(file)) continue;
      if (path.resolve(file) === path.resolve(GLOBALS_CSS)) continue;
      // Comments out first, in CSS as in TS: this rule is DISCUSSED at length in
      // the very files it governs, and an unstripped scan counted those JSDoc
      // paragraphs as call sites. Prose about a rule must never satisfy it.
      if (/env\(\s*safe-area-inset-/.test(stripComments(fs.readFileSync(file, 'utf8')))) {
        offenders.push(repoPath(file));
      }
    }
    expect(
      offenders,
      'these files call `env(safe-area-inset-*)` directly instead of ' +
        '`var(--safe-area-inset-*)`. Use the custom property — it carries the `, 0px` fallback ' +
        'that keeps the surrounding declaration valid.'
    ).toEqual([]);
  });

  it('the ledger of inset-paying call sites matches the tree, in both directions', () => {
    const found: string[] = [];
    for (const file of srcFiles(/\.(css|scss|ts|tsx)$/)) {
      if (isTestFile(file)) continue;
      if (path.resolve(file) === path.resolve(GLOBALS_CSS)) continue;
      // Comments stripped for the same reason as above — `app-layout.constants.ts`
      // documents the property and was counted as a consumer without this.
      if (/var\(--safe-area-inset-/.test(stripComments(fs.readFileSync(file, 'utf8'))))
        found.push(repoPath(file));
    }
    expect(
      found.sort(),
      'the set of files paying a display-cutout inset changed. SHRANK: an edge-anchored element ' +
        'stopped compensating and now sits under the notch or home indicator on every notched ' +
        'device — restore it rather than editing this list. GREW: a new consumer was added; ' +
        'add it here deliberately once you have checked it pays the RIGHT edge.'
    ).toEqual([...INSET_CONSUMERS].sort());
  });
});

/**
 * 🔴 WHY THIS BLOCK EXISTS AT ALL — the enumeration was blind TWICE, the same
 * way both times, and a per-file ledger cannot see either miss.
 *
 * First it missed elements edge-pinned by the shell's FLEX LAYOUT rather than
 * by a `position:` declaration (`AdhesiveAd` is the last in-flow child of a
 * 100%-height column; nothing about it greps as edge-anchored). Then it missed
 * elements positioned by MANTINE'S OWN STYLESHEET — `position: fixed` on the
 * ModalBase `inner` slot lives in node_modules, so no sweep of `src/` can see
 * a single one of the 31 Drawers or 17 fullScreen Modals.
 *
 * Both misses share one cause: the population is defined by RENDERED GEOMETRY
 * and the enumeration was over SOURCE IDIOMS. A third miss of that shape is the
 * default outcome, not a surprise, so the response is not "grep harder" — it is
 * to pay at the two places every such element must pass through:
 *
 *   R1  `position: fixed`  → containing block is the viewport. Finite, and now
 *       enumerable from EVERY stylesheet that runs, not just `src/` — for the
 *       library half that means the `@layer mantine` rules below.
 *   R2  normal flow of the app shell → its root box IS the viewport, so ONE
 *       `padding` on `#__next` moves every in-flow descendant and no
 *       enumeration is needed at all. This is where the first blind spot lived,
 *       and it is now eliminated rather than re-enumerated.
 *   R3  `absolute`/`sticky` inside an R1 or R2 box → reachable only THROUGH
 *       one of the above, so it is a bounded local review once its head is
 *       judged. (The specific hazard — an absolute child resolving against a
 *       padding box that just grew — is what moved `AppFooter`'s floating
 *       cluster 34px into the bar.)
 *
 * That taxonomy is closed: there is no fourth way for a box to reach a viewport
 * edge in CSS. What the tests below cannot promise is that the two chokepoints
 * stay wired, which is exactly why they are pinned as whole declarations rather
 * than described in a comment.
 *
 * 🔴 WHAT IS STILL UNGUARDED, stated rather than implied: a `position: fixed`
 * rule arriving in a NEW node_modules stylesheet nobody adds a rule for, and a
 * `transform`/`filter`/`contain` ancestor turning a `fixed` box into a
 * non-viewport-anchored one. Neither is observable from source.
 *
 * 🔴 RED-AT-BASE — MEASURED, NOT ASSERTED. Whole gating file re-run with
 * `globals.css`, `AppFooter.tsx`, `AdhesiveAd.tsx` and
 * `IterativeImageEditor.module.scss` restored byte-for-byte from d15e02d0d9
 * (the PR head this rework started from): **8 failed | 8 passed (16)**. The 8
 * red are the 5 chokepoint rules, the layer test, the handover test, and the
 * ledger. The 2 new tests that stayed GREEN are labelled INVARIANT GUARD at
 * their own sites and are NOT counted as coverage.
 *
 * Each was then killed in isolation, one cause per arm, and each died naming
 * its OWN assertion rather than a neighbour's:
 *   · drop `#__next`'s padding-top ....................... 1 red (the shell rule)
 *   · drop each of the 4 Mantine rules, separately ....... its own rule, + the
 *     layer test, which is why the layer test also has an arm of its own:
 *   · unwrap `@layer mantine`, rules kept verbatim ....... 1 red (layer only)
 *   · rename `data-adhesive-ad` in AdhesiveAd only ....... 1 red (handover)
 *   · re-point the `:has()` selector in globals only ..... 1 red (handover)
 *   · footer reads the raw inset instead of `-unpaid` .... 1 red (handover)
 *   · revert ONLY the floating cluster's `bottom` — i.e.
 *     exactly the defect the audit found ................ 1 red (handover, on
 *     the count: four sites must agree on the bar's height, three did not)
 *   · pad a Drawer's `content` slot at one call site ..... 1 red (that sweep)
 *   · turn one Drawer into `position="top"` ............. 1 red (that sweep)
 *   · un-pay the lightbox overlay ....................... 1 red (the ledger)
 * Unmutated control run: 16 passed (16).
 */
describe('the chokepoints that pay for whole populations', () => {
  /** Comments out, whitespace collapsed — so a reformat does not read as a change. */
  const normaliseCss = (css: string) =>
    css
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /**
   * 🔴 Each entry is the WHOLE declaration block, not a fragment. A
   * `toContain('padding-top')` is satisfied by `padding-top: 0`, by a rule on
   * the wrong selector, and by the property surviving in a comment; only the
   * selector and its full body together are a claim about what the browser
   * does. The cost is that any deliberate change here fails this test and has
   * to be re-declared, which is the intended price — these five rules are the
   * only thing paying for ~50 surfaces that name no inset themselves.
   */
  const CHOKEPOINT_RULES: ReadonlyArray<readonly [string, string]> = [
    [
      'the shell root pays the top inset for every in-flow descendant',
      '#__next { height: 100%; width: 100%; display: flex; flex-direction: column; ' +
        'padding-top: var(--safe-area-inset-top); }',
    ],
    [
      "Mantine's fixed drawer box is shrunk from the top, which reaches full-height " +
        'drawers and leaves partial-height bottom sheets alone',
      '.mantine-Drawer-inner.mantine-Drawer-inner { top: var(--safe-area-inset-top); }',
    ],
    [
      'every drawer insets its CONTENTS while its background still reaches the edge',
      '.mantine-Drawer-content { padding-bottom: var(--safe-area-inset-bottom); ' +
        'padding-inline-start: var(--safe-area-inset-left); ' +
        'padding-inline-end: var(--safe-area-inset-right); }',
    ],
    [
      "a fullScreen modal's content is the viewport box on all four edges",
      '.mantine-Modal-content[data-full-screen] { padding-top: var(--safe-area-inset-top); ' +
        'padding-bottom: var(--safe-area-inset-bottom); ' +
        'padding-inline-start: var(--safe-area-inset-left); ' +
        'padding-inline-end: var(--safe-area-inset-right); }',
    ],
    [
      "a non-fullScreen modal's existing 5dvh/5vw offset is raised only where the cutout is bigger",
      '.mantine-Modal-root:not([data-full-screen]) .mantine-Modal-inner { ' +
        'padding-top: max(var(--modal-y-offset), var(--safe-area-inset-top)); ' +
        'padding-bottom: max(var(--modal-y-offset), var(--safe-area-inset-bottom)); ' +
        'padding-inline-start: max(var(--modal-x-offset), var(--safe-area-inset-left)); ' +
        'padding-inline-end: max(var(--modal-x-offset), var(--safe-area-inset-right)); }',
    ],
  ];

  it.each(CHOKEPOINT_RULES)('%s', (_name, rule) => {
    expect(
      normaliseCss(read(GLOBALS_CSS)),
      `globals.css no longer contains this rule verbatim:\n\n  ${rule}\n\n` +
        'It is a chokepoint: deleting or narrowing it silently un-pays a whole population of ' +
        'surfaces at once, and none of them names an inset itself, so nothing else in this ' +
        'suite goes red. If the change is deliberate, re-declare the new rule here.'
    ).toContain(rule);
  });

  it('the Mantine rules sit in @layer mantine, so a component can still override them', () => {
    // Not decoration. In the UNLAYERED block lower down they would outrank
    // `@layer modules`, taking `NotificationsDrawer.module.scss`'s
    // `.inner { top: var(--header-height) }` away from it at >=xs — a component
    // that HAS reasoned about its own geometry would silently lose.
    const css = normaliseCss(read(GLOBALS_CSS));
    // Brace-matched, not `\{(.*?)\}`: an at-rule body is full of nested rules,
    // so a non-greedy match ends at the FIRST inner `}` and yields just the
    // first rule — which is precisely what the first version of this test did,
    // and the positive control below is what reported it.
    const layerBlock = braceMatched(css, css.indexOf('{', css.indexOf('@layer mantine')));
    // Positive control first: if the block did not parse, every assertion below
    // is a claim about an empty string.
    expect(
      layerBlock,
      'no `@layer mantine { … }` block was found in globals.css — the extraction below is ' +
        'searching an empty string and proves nothing.'
    ).toContain('.mantine-Drawer-content');
    for (const [, rule] of CHOKEPOINT_RULES.slice(1)) {
      expect(layerBlock, `this rule left the mantine layer:\n  ${rule}`).toContain(rule);
    }
  });

  // 🔴 INVARIANT GUARD — GREEN AT BASE, NOT REGRESSION COVERAGE. Measured: it
  // passes unchanged at d15e02d0d9, because no call site padded `content` there
  // either. It is not evidence that this change fixed anything; it pins the
  // PRECONDITION the drawer rule above depends on, which nothing else states.
  it('no Drawer or Modal call site sets padding on its `content` slot', () => {
    // The rules above pay on `content` precisely BECAUSE nothing sets padding
    // there — `body` is where ~20 filter drawers write `padding: 16` as an
    // inline style, which beats any stylesheet rule. That is a property of the
    // tree today, not a guarantee, so it is measured every run: the first call
    // site to set `content` padding wipes the drawer's bottom inset at that one
    // surface, with nothing else to report it.
    const offenders: string[] = [];
    let contentSlotsSeen = 0;
    for (const file of srcFiles(/\.tsx$/)) {
      if (isTestFile(file)) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const tag of ['<Drawer', '<Modal']) {
        let at = src.indexOf(tag);
        while (at !== -1) {
          // The opening tag's own props, bounded so a later unrelated
          // `styles={{ content: … }}` in the same file is not attributed here.
          const window = src.slice(at, at + 1500);
          const stylesAt = window.search(/\bstyles=\{\{/);
          if (stylesAt !== -1) {
            const obj = braceMatched(window, window.indexOf('{', stylesAt));
            const contentAt = obj.search(/\bcontent\s*:\s*\{/);
            if (contentAt !== -1) {
              contentSlotsSeen++;
              const slot = braceMatched(obj, obj.indexOf('{', contentAt));
              if (/\bpadding/i.test(slot)) offenders.push(`${repoPath(file)} :: ${slot.trim()}`);
            }
          }
          at = src.indexOf(tag, at + 1);
        }
      }
    }
    // 🔴 POSITIVE CONTROL. A zero-offender result is indistinguishable from a
    // sweep wired to nothing, so report the pair: the walk must have READ some
    // `content` slots before its silence means anything. Four are known
    // (challenges, auctions, AdaptiveFiltersDropdown, ModelFiltersDropdown-style
    // `content: { height, maxHeight }` blocks); the floor is deliberately below
    // the real count so removing one drawer does not fail this for the wrong
    // reason.
    expect(
      contentSlotsSeen,
      'the sweep found NO `content` slot on any Drawer/Modal, so its zero-offender verdict is a ' +
        'fact about the parser, not about the tree. Check the brace matching before trusting it.'
    ).toBeGreaterThanOrEqual(3);
    expect(
      offenders,
      'these call sites set padding on a Drawer/Modal `content` slot, which is the box the ' +
        '`@layer mantine` rules in globals.css pay the safe-area inset on. An inline `styles` ' +
        'prop outranks a stylesheet, so this surface is now UNPAID at the bottom edge. Move the ' +
        'padding to the `body` slot, which composes with the inset instead of replacing it.'
    ).toEqual([]);
  });

  // 🔴 INVARIANT GUARD — GREEN AT BASE, NOT REGRESSION COVERAGE. Same status as
  // the one above: zero `position="top"` Drawers existed at d15e02d0d9 and zero
  // exist now. It pins the second precondition of the unconditional drawer rule.
  it('no Drawer uses position="top", which the unconditional bottom padding would over-pay', () => {
    // The drawer rules are unconditional because Mantine emits no
    // `data-position` — position becomes an inline `--drawer-align` that CSS
    // cannot branch on. Unconditional is CORRECT for `bottom`, `left` and
    // `right`, whose content all reaches the bottom edge; it is over-payment
    // for `top`, whose content does not. There are none today. If one is added
    // this fails, and the fix is a `styles={{ content: { paddingBottom: 0 } }}`
    // at that call site plus an entry in the sweep above.
    const offenders: string[] = [];
    for (const file of srcFiles(/\.tsx$/)) {
      if (isTestFile(file)) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      let at = src.indexOf('<Drawer');
      while (at !== -1) {
        if (/position\s*=\s*(["']top["']|\{[^}]*['"]top['"][^}]*\})/.test(src.slice(at, at + 1500)))
          offenders.push(repoPath(file));
        at = src.indexOf('<Drawer', at + 1);
      }
    }
    expect(
      offenders,
      'a `position="top"` Drawer was added. `.mantine-Drawer-content` pays a bottom inset ' +
        'unconditionally, and a top drawer does not reach the bottom edge, so it now carries a ' +
        '34px gap it does not need. Zero it at the call site and record it here.'
    ).toEqual([]);
  });
});

describe('the AppFooter / AdhesiveAd bottom-edge handover', () => {
  const ADHESIVE_AD = path.join(REPO_ROOT, 'src/components/Ads/AdhesiveAd.tsx');
  const APP_FOOTER = path.join(REPO_ROOT, 'src/components/AppLayout/AppFooter.tsx');

  /**
   * 🔴 THE TWO HALVES ARE IN DIFFERENT FILES AND NEITHER READS AS BROKEN ALONE.
   * `AdhesiveAd` carries `data-adhesive-ad`; `globals.css` keys
   * `#__next:has([data-adhesive-ad])` off it to zero
   * `--safe-area-inset-bottom-unpaid`; `AppFooter` reads that property. Rename
   * the attribute and every file still looks deliberate, every existing test
   * still passes, and the footer quietly pays a second time — a 34px gap above
   * the ad bar on exactly the population that sees ads.
   *
   * This is the seam, so it is asserted as a RELATIONSHIP: all three sides, in
   * one test, failing if any one of them moves.
   */
  it('all three sides of the handover agree', () => {
    const ad = stripComments(read(ADHESIVE_AD));
    const css = read(GLOBALS_CSS);
    const footer = stripComments(read(APP_FOOTER));

    expect(
      ad,
      '`AdhesiveAd` no longer marks its bar with `data-adhesive-ad`. That attribute is not ' +
        'decorative — it is the only signal `AppFooter` has that something below it is already ' +
        'paying the bottom inset.'
    ).toContain('data-adhesive-ad');
    expect(
      css,
      'globals.css no longer keys off `data-adhesive-ad`. Without this rule ' +
        '`--safe-area-inset-bottom-unpaid` never goes to 0, so the footer bar pays the inset ' +
        'even when the ad bar below it is already paying it.'
    ).toContain('#__next:has([data-adhesive-ad])');
    expect(
      css,
      'the `--safe-area-inset-bottom-unpaid` default is gone or no longer defers to the real ' +
        'inset, so the footer pays nothing when it IS the viewport bottom.'
    ).toContain('--safe-area-inset-bottom-unpaid: var(--safe-area-inset-bottom);');

    // 🔴 The footer must read the CONDITIONAL property, not the raw inset. Four
    // places have to agree or the bar's height, its padding, the floating
    // cluster's offset and the hide transform describe four different bars.
    const uses = footer.match(/var\(--safe-area-inset-bottom-unpaid\)/g) ?? [];
    expect(
      uses,
      '`AppFooter` must read `--safe-area-inset-bottom-unpaid` in exactly four places: the ' +
        "bar's height, the bar's padding-bottom, the floating cluster's `bottom` offset, and " +
        'the hide transform. Fewer means one of them is describing a different bar height than ' +
        'the others — which is how the cluster ended up 34px inside the bar.'
    ).toHaveLength(4);
    expect(
      footer,
      '`AppFooter` reads the raw `--safe-area-inset-bottom`. It is `sticky bottom-0` INSIDE the ' +
        'ScrollArea, so it is the viewport bottom only when `AdhesiveAd` is not rendering below ' +
        'it — use `--safe-area-inset-bottom-unpaid`, which asks the DOM.'
    ).not.toMatch(/var\(--safe-area-inset-bottom\)/);
  });
});
