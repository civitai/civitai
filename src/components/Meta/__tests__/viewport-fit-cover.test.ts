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
  'src/components/Image/DetailV2/ImageDetail2.tsx',
  'src/components/ImageGeneration/GeneratedOutputLightbox.tsx',
  'src/components/IterativeEditor/IterativeImageEditor.module.scss',
  // The ONE node_modules viewport-edge surface paid at its call site rather
  // than at the `@layer mantine` seam: `@mantine/nprogress` renders a
  // `<Progress>`, so its static class is `mantine-Progress-root` — shared with
  // every other progress bar in the app, and therefore unusable as a selector.
  // See the comment at that call site.
  'src/components/RouterTransition/RouterTransition.tsx',
  // The one component that OUTRANKS the shell's Mantine drawer rule (its
  // `.module.scss` is in `@layer modules`) and therefore has to re-pay the top
  // inset itself. It is in this ledger for that reason, not because it is an
  // ordinary call site.
  'src/components/Notifications/NotificationsDrawer.module.scss',
  'src/components/Sticker/StickerPlacementTray.tsx',
  // Here for the same reason as NotificationsDrawer, via the other override
  // channel: a Tailwind utility in `classNames` is UNLAYERED, so its `inner`
  // padding outranks the shell's modal rule and it has to fold the inset in
  // itself. The only `inner:` override in the app.
  'src/components/Support/SupportModal.tsx',
  'src/components/generation_v2/GenerationLayout.tsx',
  'src/pages/comics/project/[id]/ProjectWorkspace.module.scss',
  // `src/providers/ThemeProvider.tsx` LEFT this list deliberately. It used to
  // pay `@mantine/notifications` with a `style` prop, which reached one of the
  // three `<Notifications />` in the tree and could not be right for the
  // `top-*` and `bottom-*` containers at once (one `style` is spread onto all
  // six). That payment moved to the `data-position`-branched rules in
  // globals.css, which are pinned as chokepoints below.
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

/**
 * The value of the `slot:` property beginning at `slotAt` in an object literal:
 * a brace-matched object, a whole quoted string, or the rest up to the next
 * comma.
 *
 * 🔴 THE QUOTED-STRING CASE IS WHY THIS IS NOT A `indexOf(',')`. A Tailwind
 * arbitrary value contains commas — `pb-[max(1.5rem,var(--safe-area-inset-…))]`
 * — so a comma-terminated read returns `'pt-[max(1.5rem` and the caller then
 * cannot see the `safe-area-inset` that makes the value COMPLIANT. Measured:
 * it reported `SupportModal` as an offender immediately after that file was
 * fixed, i.e. the guard was grading the truncation rather than the code.
 */
function slotValue(obj: string, slotAt: number): string {
  const colon = obj.indexOf(':', slotAt);
  let i = colon + 1;
  while (i < obj.length && /\s/.test(obj[i])) i++;
  if (obj[i] === '{') return braceMatched(obj, i);
  if (obj[i] === "'" || obj[i] === '"' || obj[i] === '`') {
    const close = obj.indexOf(obj[i], i + 1);
    return close === -1 ? obj.slice(i) : obj.slice(i, close + 1);
  }
  const comma = obj.indexOf(',', i);
  return obj.slice(i, comma === -1 ? undefined : comma);
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
 * 🔴 THIS BLOCK IS THE R1 CLAIM, TURNED FROM A SENTENCE INTO A MEASUREMENT.
 *
 * The comment above the `@layer mantine` rules used to assert that
 * `position: fixed` had been enumerated "from every stylesheet that runs, not
 * just `src/**`". That was false. What had actually been swept was
 * `@mantine/core`; the app loads eight more stylesheets, two of which ship
 * viewport-edge surfaces that went unpaid — `@mantine/nprogress`'s
 * `fixed; top: 0` bar, rendered on EVERY route, and `mantine-react-table`'s
 * `fixed; bottom: 0` fullscreen toolbar.
 *
 * The lesson is not "sweep harder". It is that a coverage claim written in
 * prose is unfalsifiable, and a comment claiming coverage it does not have is
 * WORSE than no comment, because it stops the next person looking. So the
 * population is enumerated here, mechanically, from the import statements that
 * define it — and the ledger fails on GROWTH (a new stylesheet nobody has
 * swept) as well as on SHRINK (one silently dropped, taking a rule written for
 * it out of the cascade while the rule itself still reads as live).
 *
 * 🔴 THE FIXED/STICKY COUNTS ARE PART OF THE LEDGER, and they are the half that
 * survives a version bump. The import list only changes when someone edits
 * `_app.tsx`; the RULES inside those files change whenever the package does,
 * silently, in a lockfile diff nobody reads as a layout change. A new
 * `position: fixed` in `@mantine/core` is exactly the miss this whole PR is
 * about, and the count is the only thing that can see it.
 *
 * 🔴 WHAT THIS STILL CANNOT SEE, said plainly: a stylesheet injected at runtime
 * by JS (none today), a fixed box created by an inline style rather than a
 * stylesheet (`mantine-react-table`'s fullscreen Paper is one — pinned
 * separately, by class name, in the chokepoint block), and whether any of these
 * surfaces is actually REACHED by a call site. Reachability is a judgement
 * recorded in the globals.css comment, not something a test decides.
 *
 * 🔴 RED-AT-BASE for this block: it is REGRESSION COVERAGE for the ledger tests
 * (both fail at 2fdcac44e0, the PR head this rework started from: at that ref
 * `RouterTransition.tsx` pays nothing and the recorded verdicts do not exist)
 * and an INVARIANT GUARD for the two count tests, which pass at 2fdcac44e0 as
 * well — node_modules is the same tree. The guards are labelled as such and are
 * not counted as coverage; their killing mutation is a package upgrade.
 */
describe('the stylesheets that actually run, enumerated rather than asserted', () => {
  const APP_TSX = path.join(REPO_ROOT, 'src/pages/_app.tsx');

  /**
   * Every way a stylesheet can be made to RUN: the static side-effect
   * `import 'x.css'`, `require('x.css')`, and a dynamic `import('x.css')`.
   *
   * 🔴 THE LAST TWO EXIST NOWHERE IN THE TREE TODAY, WHICH IS PRECISELY WHY
   * THEY ARE IN THE PATTERN. Swept 2026-08-31 over every `.ts`/`.tsx` under
   * `src/`: zero `require(…css|scss)`, zero `import(…css|scss)`. A pattern
   * that only knows the form currently in use reports NO GROWTH for the first
   * one anybody adds — a stylesheet running unswept while the ledger says the
   * population is unchanged, which is the exact failure this ledger exists to
   * prevent. The extractor therefore has its own positive control below,
   * because the two ledger tests are both ABSENCE tests and a branch that
   * matches nothing returns the expected answer on today's tree.
   *
   * `import x from 'y.module.css'` is a CSS Module — scoped to one component,
   * inside `@layer modules` — and is not part of this population; the static
   * branch excludes it by requiring the quote to follow `import` directly.
   * The `require`/dynamic-`import` branches deliberately do NOT try to make
   * that distinction (`const s = require('x.css')` matches). Over-including
   * costs one deliberate review; under-including is the hole above.
   */
  const sideEffectStylesheets = (src: string) =>
    [
      ...src.matchAll(
        /(?:^\s*import\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+\.(?:css|scss))['"]/gm
      ),
    ].map((m) => m[1]);

  /**
   * 🔴 POSITIVE CONTROL FOR THE EXTRACTOR, AND IT HAS TO BE A FIXTURE. Both
   * ledger tests below assert that nothing UNEXPECTED was found, so a broken
   * branch — one that can no longer match its form — produces exactly the
   * passing answer on a tree that contains none of that form. Only a string
   * that definitely contains all three can tell a working branch from a dead
   * one. Each expected value is distinct, so dropping any single branch
   * changes the result.
   */
  it('the stylesheet extractor sees all three ways a stylesheet can be made to run', () => {
    const fixture = [
      `import '~/styles/globals.css';`,
      `import classes from './scoped.module.css';`,
      `require('legacy/theme.css');`,
      `const t = require("legacy/other.scss");`,
      `await import('./lazy-widget.css');`,
      `void import("./lazy-two.scss");`,
      `import { Something } from './not-a-stylesheet';`,
    ].join('\n');
    expect(
      sideEffectStylesheets(fixture),
      'the stylesheet extractor stopped recognising one of the three forms (or started ' +
        'claiming a CSS Module is a global stylesheet). Until this passes, both ledger tests ' +
        'below are reading the tree with a pattern that cannot see part of the population, ' +
        'and every "no growth" verdict they give is void.'
    ).toEqual([
      '~/styles/globals.css',
      'legacy/theme.css',
      'legacy/other.scss',
      './lazy-widget.css',
      './lazy-two.scss',
    ]);
  });

  /**
   * The eight global stylesheets `_app.tsx` loads, in its own order. Order
   * matters and is asserted with them: globals.css is imported FIRST, which is
   * why the drawer rule needs a doubled class to win a same-layer source-order
   * tie against Mantine's own `top: 0`.
   */
  const APP_STYLESHEETS = [
    '~/styles/globals.css',
    '@mantine/core/styles.layer.css',
    '@mantine/dates/styles.layer.css',
    '@mantine/dropzone/styles.layer.css',
    '@mantine/notifications/styles.layer.css',
    '@mantine/nprogress/styles.layer.css',
    '@mantine/tiptap/styles.layer.css',
    'mantine-react-table/styles.css',
  ];

  /**
   * Every OTHER side-effect stylesheet import in the tree, i.e. the ones a
   * sweep of `_app.tsx` alone would miss. Route-scoped rather than global, but
   * they still run.
   */
  const ROUTE_SCOPED_STYLESHEETS: ReadonlyArray<readonly [string, string]> = [
    ['src/components/Training/Form/TrainingImagesCaptionViewer.tsx', 'draft-js/dist/Draft.css'],
  ];

  /**
   * Viewport-anchored declaration counts, and the verdict recorded for each
   * file. A count that MOVES means the package changed what it pins to the
   * viewport; re-read the file, decide, and update both the number and the
   * globals.css comment that lists these verdicts.
   */
  const EDGE_RULE_INVENTORY: ReadonlyArray<readonly [string, number, number]> = [
    // [package-relative path under node_modules, `position: fixed`, `position: sticky`]
    ['@mantine/core/styles.layer.css', 8, 3],
    ['@mantine/dates/styles.layer.css', 0, 0],
    ['@mantine/dropzone/styles.layer.css', 1, 0],
    ['@mantine/notifications/styles.layer.css', 1, 0],
    ['@mantine/nprogress/styles.layer.css', 1, 0],
    ['@mantine/tiptap/styles.layer.css', 0, 1],
    ['mantine-react-table/styles.css', 1, 9],
    ['draft-js/dist/Draft.css', 0, 0],
  ];

  it('_app.tsx loads exactly the stylesheets that were swept, in the recorded order', () => {
    // Comment-stripped for the same reason the sweep below is: the widened
    // pattern matches `require(…)`/`import(…)` ANYWHERE on a line, so a
    // commented-out one would otherwise be counted as a running stylesheet.
    const found = sideEffectStylesheets(stripComments(read(APP_TSX)));
    expect(
      found,
      'the set of global stylesheets changed. GREW: a package stylesheet was added and nobody ' +
        'has swept it for viewport-anchored rules — do that, record the verdict in the ' +
        '"MANTINE\'S OWN VIEWPORT-EDGE SURFACES" comment in globals.css, and add it here plus ' +
        'to EDGE_RULE_INVENTORY. SHRANK: a stylesheet was dropped; any globals.css rule written ' +
        'for it is now dead weight that still reads as live. Either way this is a deliberate ' +
        'edit, not a list to sync.'
    ).toEqual(APP_STYLESHEETS);
  });

  it('no other file side-effect-imports a stylesheet without being on the list', () => {
    const found: Array<[string, string]> = [];
    for (const file of srcFiles(/\.(ts|tsx)$/)) {
      if (isTestFile(file)) continue;
      if (path.resolve(file) === path.resolve(APP_TSX)) continue;
      for (const spec of sideEffectStylesheets(stripComments(fs.readFileSync(file, 'utf8')))) {
        found.push([repoPath(file), spec]);
      }
    }
    expect(
      found.sort(),
      'a component side-effect-imports a global stylesheet that is not in the swept set. It ' +
        'runs on every route that renders that component, so its viewport-anchored rules are ' +
        'live — sweep it and record the verdict, or make it a CSS Module.'
    ).toEqual([...ROUTE_SCOPED_STYLESHEETS].map((e) => [...e]).sort());
  });

  /**
   * 🔴 POSITIVE CONTROL FOR THE COUNTS BELOW, AND IT HAS TO BE ITS OWN TEST.
   * Half the inventory legitimately records `0, 0` — `@mantine/dates` and
   * `draft-js` position nothing — so a zero there is the EXPECTED reading, and
   * it is indistinguishable from a zero produced by a regex that can no longer
   * match anything (a formatting change to `position : fixed`, a switch to a
   * minified `position:fixed;` bundle, a package that stops shipping CSS). A
   * per-file control cannot separate those, because on those files there is
   * nothing for it to find. So the control runs once, against the file with the
   * most positioned boxes, and a failure HERE means every `0` below is void.
   *
   * The first version of this WAS a per-file control, and it went red on
   * `@mantine/dates` immediately — which is the control doing its job in the
   * wrong place, not a defect in the package.
   */
  it('the position: counter can find rules at all (control for the zeros below)', () => {
    const core = read(path.join(REPO_ROOT, 'node_modules/@mantine/core/styles.layer.css'));
    expect(
      core.match(/position:\s*fixed/g) ?? [],
      'the `position: fixed` pattern found nothing in @mantine/core, which certainly has some. ' +
        'Every count in the inventory below is now being read by a pattern that matches ' +
        'nothing, so every recorded 0 is meaningless. Fix the pattern before trusting any of ' +
        'them.'
    ).not.toHaveLength(0);
    expect(
      core.match(/position:\s*sticky/g) ?? [],
      'the `position: sticky` pattern found nothing in @mantine/core — same problem, other half.'
    ).not.toHaveLength(0);
  });

  it.each(EDGE_RULE_INVENTORY)(
    '%s still declares the reviewed number of viewport-anchored rules',
    (spec, fixed, sticky) => {
      const file = path.join(REPO_ROOT, 'node_modules', spec);
      const css = read(file);
      expect(
        css.match(/position:\s*fixed/g) ?? [],
        `${spec} changed how many boxes it pins to the VIEWPORT. Read the new ones and decide ` +
          'whether each is a viewport EDGE (pay it) or a scrim / floating box anchored to a ' +
          'target (do not). Record the verdict in globals.css and update this number.'
      ).toHaveLength(fixed);
      expect(
        css.match(/position:\s*sticky/g) ?? [],
        `${spec} changed how many boxes it makes sticky. A sticky box is only a viewport-edge ` +
          'surface when its scrollport is the viewport — check which, then update this number.'
      ).toHaveLength(sticky);
    }
  );
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
 *   R1  `position: fixed`  → containing block is the viewport. Finite, and
 *       enumerable — but only over a population someone has actually named.
 *       🔴 The first pass wrote "every stylesheet that runs" and had swept
 *       ONE of nine; `@mantine/nprogress` and `mantine-react-table` were both
 *       unpaid. The population is now derived from the import statements
 *       rather than described, by the block above, which also records the
 *       per-file rule counts so a package upgrade that adds a fixed surface
 *       goes red instead of shipping.
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
 * 🔴 WHAT IS STILL UNGUARDED, stated rather than implied: a
 * `transform`/`filter`/`contain` ancestor turning a `fixed` box into a
 * non-viewport-anchored one; a stylesheet injected at runtime by JS; and
 * REACHABILITY — the inventory above sees a new `position: fixed` rule appear,
 * but whether any call site renders the component it belongs to is a judgement
 * a human records, not something a test decides. (`Affix`, `AppShell` and
 * `Dropzone.FullScreen` are all viewport-edge surfaces in the loaded set, and
 * all three have zero call sites today.)
 *
 * 🔴 RED-AT-BASE — MEASURED, NOT ASSERTED. Whole gating file re-run with all
 * twelve touched source files restored byte-for-byte from d15e02d0d9 (the PR
 * head this rework started from): **10 failed | 7 passed (17)**, against
 * **17 passed (17)** at HEAD. The 10 red are the 5 chokepoint rules, the layer
 * test, the override sweep, the handover test, its page-content half, and the
 * ledger. Of the 7 green, 6 are the pre-existing viewport-meta and inset-layer
 * tests and ONE is a new test labelled INVARIANT GUARD at its own site; that
 * one is NOT counted as coverage.
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
 *   · turn one Drawer into `position="top"` ............. 1 red (that sweep)
 *   · un-pay the lightbox overlay ....................... 1 red (the ledger)
 * and, across all THREE channels the override sweep claims to cover:
 *   · `styles={{ content: { padding } }}` on a Drawer ... 1 red (the sweep)
 *   · `classNames={{ inner: 'py-6' }}` on a Modal ....... the sweep + the ledger
 *   · a `.module.scss` `.inner { top }` via `classNames`  the sweep + the ledger
 *   · a `.module.scss` `.content { padding }` ........... 1 red (the sweep)
 * Unmutated control run before and after every arm: 17 passed (17).
 *
 * 🔴 That third-channel arm is why the sweep strips CSS comments. It first
 * scored GREEN with the real declaration deleted, because the file explains its
 * own inset in a comment naming `--safe-area-inset-top` four times and the
 * compliance check read the prose. Only the ledger caught it. Prose about a
 * rule must never satisfy it.
 *
 * 🔴 SECOND MATRIX, for the tests added when the R1 sweep was found to have
 * covered one stylesheet of nine. Base = 2fdcac44e0 (the PR head at that
 * point), with the five touched source files — globals.css, RouterTransition,
 * ThemeProvider, data-graph-v2, dev/prompt-snippets — restored byte-for-byte
 * and the test files left at HEAD: **13 failed | 26 passed (39)**, against
 * **39 passed (39)** at HEAD. The 13 are the ledger, the four new notification
 * rules, the two rewritten modal rules, the modal stand-down (as a chokepoint
 * AND as the three-file relationship), the two MRT rules, and both layer-
 * placement tests.
 *
 * 🔴 That count was 12 on the first measurement, and the missing red is the
 * lesson: `the MRT rules sit OUTSIDE @layer mantine` asserted only
 * `not.toContain`, which a rule that has not been written yet satisfies
 * vacuously. It now establishes presence first. An absence assertion is worth
 * nothing until something has been shown to exist.
 *
 * 🔴 FOUR OF THE NEW TESTS ARE INVARIANT GUARDS AND ARE NOT COUNTED AS
 * COVERAGE — they are green at base by construction, because what they read is
 * `_app.tsx` and `node_modules`, neither of which this change touches:
 *   · `_app.tsx loads exactly the stylesheets that were swept`
 *   · `no other file side-effect-imports a stylesheet…`
 *   · the `EDGE_RULE_INVENTORY` count cases (8 of them)
 *   · `the MRT rules' class names are the ones the installed package emits`
 * Their killing mutation is upstream — a package upgrade, or someone adding an
 * import to `_app.tsx` — which is exactly the change no reviewer of a layout PR
 * would think to check, and exactly how the two unpaid surfaces got in.
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
      '.mantine-Modal-content[data-full-screen] { ' +
        '--safe-area-inset-bottom-modal: var(--safe-area-inset-bottom); ' +
        'padding-top: var(--safe-area-inset-top); ' +
        'padding-bottom: var(--safe-area-inset-bottom-modal); ' +
        'padding-inline-start: var(--safe-area-inset-left); ' +
        'padding-inline-end: var(--safe-area-inset-right); }',
    ],
    [
      'a fullScreen modal that contains its OWN ad bar stands down, scoped to its own subtree',
      '.mantine-Modal-content[data-full-screen]:has([data-adhesive-ad]) { ' +
        '--safe-area-inset-bottom-modal: 0px; }',
    ],
    [
      "a non-fullScreen modal's existing 5dvh/5vw offset is raised only where the cutout is bigger",
      '.mantine-Modal-root:not([data-full-screen]) .mantine-Modal-inner { ' +
        'padding-top: max(var(--modal-y-offset), var(--safe-area-inset-top)); ' +
        'padding-bottom: max(var(--modal-y-offset), var(--safe-area-inset-bottom)); ' +
        'padding-inline-start: max(var(--modal-x-offset), var(--safe-area-inset-left)); ' +
        'padding-inline-end: max(var(--modal-x-offset), var(--safe-area-inset-right)); }',
    ],
    [
      "the same two terms cap the content's height, so the raised padding and the allowance " +
        'cannot disagree',
      '.mantine-Modal-root:not([data-full-screen]) { --modal-content-max-height: calc( ' +
        '100dvh - max(var(--modal-y-offset), var(--safe-area-inset-top)) - ' +
        'max(var(--modal-y-offset), var(--safe-area-inset-bottom)) ); }',
    ],
    [
      'each notification container pays only the edge its own data-position names (top block)',
      ".mantine-Notifications-root[data-position^='top-'] { " +
        'margin-block-start: var(--safe-area-inset-top); }',
    ],
    [
      'each notification container pays only the edge its own data-position names (bottom block)',
      ".mantine-Notifications-root[data-position^='bottom-'] { " +
        'margin-block-end: var(--safe-area-inset-bottom); }',
    ],
    [
      'each notification container pays only the edge its own data-position names (inline start)',
      ".mantine-Notifications-root[data-position$='-left'] { " +
        'margin-inline-start: var(--safe-area-inset-left); }',
    ],
    [
      'each notification container pays only the edge its own data-position names (inline end)',
      ".mantine-Notifications-root[data-position$='-right'] { " +
        'margin-inline-end: var(--safe-area-inset-right); }',
    ],
  ];

  /**
   * `mantine-react-table` ships UNLAYERED CSS, so its two rules cannot live in
   * the block above — an unlayered declaration beats every layered one whatever
   * the specificity, and a layered rule aimed at these boxes is inert. They are
   * pinned with the same whole-declaration contract, separately, so that the
   * layer test below can assert the OTHERS are inside `@layer mantine` without
   * these two making it fail.
   */
  const UNLAYERED_CHOKEPOINT_RULES: ReadonlyArray<readonly [string, string]> = [
    [
      "MRT's inline-styled fullscreen Paper is padded with !important, the only channel an " +
        'inline `padding: 0` leaves open',
      '.mrt-table-paper-fullscreen { padding-top: var(--safe-area-inset-top) !important; ' +
        'padding-inline-start: var(--safe-area-inset-left) !important; ' +
        'padding-inline-end: var(--safe-area-inset-right) !important; }',
    ],
    [
      "MRT's fullscreen bottom toolbar is `position: fixed`, so it escapes the Paper's padding " +
        'box and pays its own',
      '.mrt-table-paper-fullscreen .mrt-bottom-toolbar { ' +
        'padding-bottom: var(--safe-area-inset-bottom); }',
    ],
  ];

  it.each([...CHOKEPOINT_RULES, ...UNLAYERED_CHOKEPOINT_RULES])('%s', (_name, rule) => {
    expect(
      normaliseCss(read(GLOBALS_CSS)),
      `globals.css no longer contains this rule verbatim:\n\n  ${rule}\n\n` +
        'It is a chokepoint: deleting or narrowing it silently un-pays a whole population of ' +
        'surfaces at once, and none of them names an inset itself, so nothing else in this ' +
        'suite goes red. If the change is deliberate, re-declare the new rule here.'
    ).toContain(rule);
  });

  /**
   * The mirror of the layer test below, and it is NOT symmetry for its own
   * sake: `mantine-react-table/styles.css` carries zero `@layer` at-rules, so a
   * rule aimed at its boxes from inside `@layer mantine` loses to it however
   * specific it is and does nothing at all — the same silent-inertness failure
   * the layer test guards from the other direction.
   *
   * Both halves are asserted: that the package really is unlayered (so the
   * premise stays true across upgrades), and that our two rules really are
   * outside the layer block.
   */
  it('the MRT rules sit OUTSIDE @layer mantine, because MRT ships unlayered CSS', () => {
    const mrtCss = read(path.join(REPO_ROOT, 'node_modules/mantine-react-table/styles.css'));
    // Positive control on the read itself before the claim about its content:
    // an empty or wrong file would make the `@layer` count vacuously 0.
    expect(
      mrtCss,
      'mantine-react-table/styles.css does not contain the fullscreen bottom-toolbar rule these ' +
        'two globals.css rules exist for. The package layout changed; re-derive them.'
    ).toMatch(/position:\s*fixed\s*!important/);
    expect(
      mrtCss.match(/@layer\b/g) ?? [],
      'mantine-react-table now ships LAYERED css. That inverts the cascade argument for the two ' +
        'unlayered `.mrt-table-paper-fullscreen` rules in globals.css: unlayered rules beat ' +
        'layered ones, so ours would now also beat `@layer modules` for no reason. Move them ' +
        'into `@layer mantine` and move their entries to CHOKEPOINT_RULES.'
    ).toHaveLength(0);

    const css = normaliseCss(read(GLOBALS_CSS));
    const layerBlock = braceMatched(css, css.indexOf('{', css.indexOf('@layer mantine')));
    expect(layerBlock, 'the `@layer mantine` block did not parse').toContain(
      '.mantine-Drawer-content'
    );
    for (const [, rule] of UNLAYERED_CHOKEPOINT_RULES) {
      // 🔴 PRESENCE FIRST, THEN PLACEMENT. `not.toContain` on a rule that does
      // not exist at all is vacuously true — measured: without this line the
      // test passed at 2fdcac44e0, where neither rule had been written yet.
      // The absence only means something once presence is established.
      expect(
        css,
        `globals.css no longer contains this rule at all, so the placement assertion below ` +
          `proves nothing:\n  ${rule}`
      ).toContain(rule);
      expect(
        layerBlock,
        `this rule moved INTO @layer mantine and is now inert against mantine-react-table's ` +
          `unlayered stylesheet:\n  ${rule}`
      ).not.toContain(rule);
    }
  });

  /**
   * The stable, unhashed class names the two MRT rules select on are string
   * literals in the package's own bundle, applied alongside the hashed
   * CSS-module classes. A selector that matches nothing is not an error in any
   * tool, so this is the only thing that would report an upgrade renaming them.
   */
  it("the MRT rules' class names are the ones the installed package emits", () => {
    const bundle = read(
      path.join(REPO_ROOT, 'node_modules/mantine-react-table/dist/index.esm.mjs')
    );
    for (const cls of ['mrt-table-paper-fullscreen', 'mrt-bottom-toolbar']) {
      expect(
        bundle,
        `mantine-react-table no longer emits the class \`${cls}\`. The globals.css rule keyed on ` +
          'it is now inert, and the fullscreen table pays no inset — its pagination row sits ' +
          'under the home indicator on the five moderator tables that have the fullscreen ' +
          'toggle enabled.'
      ).toContain(`'${cls}'`);
    }
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

  /**
   * 🔴 RED AT BASE — REGRESSION COVERAGE, NOT AN INVARIANT GUARD. Measured: it
   * fails at d15e02d0d9 on two real offenders, `SupportModal`'s
   * `classNames={{ inner: 'py-6' }}` and `NotificationsDrawer.module.scss`'s
   * flat `.inner { top: var(--header-height) }`. Both are fixed in this change.
   * It pins what the `@layer mantine` rules depend on: that nothing outranks
   * them on the boxes they pay.
   *
   * 🔴 IT COVERS THREE OVERRIDE CHANNELS, BECAUSE ITS FIRST VERSION COVERED ONE
   * AND WAS WRONG ABOUT THE TREE. That version read only `styles={{ … }}`
   * while its name said "call site", and reported the tree clean while
   * `SupportModal`'s `classNames={{ inner: 'py-6' }}` was defeating the
   * non-fullScreen modal rule. The channels, in increasing order of how badly
   * they outrank a stylesheet:
   *   1. `styles={{ slot: { padding } }}`   — inline style
   *   2. `classNames={{ slot: 'p-6' }}`     — Tailwind utility, UNLAYERED
   *   3. `classNames={classes}` + a `.module.scss` rule — `@layer modules`
   * The third is the one that produced the real defect: `NotificationsDrawer`
   * pins its own `.inner { top }`, and left alone it would have overlapped the
   * header by the inset.
   *
   * 🔴 IT IS SCOPED TO THE BOX EACH RULE ACTUALLY PAYS, or it flags surfaces
   * that are fine: `content` padding matters on a Drawer and on a fullScreen
   * Modal; `inner` padding matters on a non-fullScreen Modal; `inner`'s `top`
   * matters on a Drawer. A plain Modal's `content: 'p-0'` is none of those and
   * is deliberately not reported.
   */
  it('nothing outranks the @layer mantine rules on the boxes they pay', () => {
    const offenders: string[] = [];
    let slotsSeen = 0;

    /** A value that folds the inset in itself is compliant, not an offender. */
    const paysInset = (v: string) => /safe-area-inset/.test(v);
    const setsPadding = (v: string) =>
      /\bpadding/i.test(v) || /(^|[\s'"`])p[tbxy]?-[\w[\]./%-]+/.test(v);

    for (const file of srcFiles(/\.tsx$/)) {
      if (isTestFile(file)) continue;
      const src = stripComments(fs.readFileSync(file, 'utf8'));
      for (const tag of ['<Drawer', '<Modal'] as const) {
        let at = src.indexOf(tag);
        while (at !== -1) {
          // Walk to the end of the OPENING tag, brace-aware. A fixed character
          // window truncates a long prop list and stops seeing the very props
          // it is looking for — measured: that mistake counted 15 fullScreen
          // modals where a brace-aware walk finds 17.
          let end = -1;
          for (let i = at, depth = 0; i < src.length; i++) {
            const c = src[i];
            if (c === '{') depth++;
            else if (c === '}') depth--;
            else if (c === '>' && depth === 0) {
              end = i;
              break;
            }
          }
          const head = src.slice(at, end > 0 ? end + 1 : at + 2000);
          const isDrawer = tag === '<Drawer';
          const isFullScreen = /\bfullScreen\b/.test(head);
          // Which slot is load-bearing HERE. See the scoping note above.
          const watched: Array<[slot: string, why: string]> = isDrawer
            ? [['content', 'the drawer bottom/side inset']]
            : isFullScreen
            ? [['content', 'the fullScreen modal inset']]
            : [['inner', 'the non-fullScreen modal cutout offset']];

          for (const prop of ['styles', 'classNames'] as const) {
            const propAt = head.search(new RegExp(`\\b${prop}=\\{\\{`));
            if (propAt === -1) continue;
            const obj = braceMatched(head, head.indexOf('{', propAt));
            for (const [slot, why] of watched) {
              const slotAt = obj.search(new RegExp(`\\b${slot}\\s*:`));
              if (slotAt === -1) continue;
              slotsSeen++;
              const value = slotValue(obj, slotAt);
              if (setsPadding(value) && !paysInset(value))
                offenders.push(
                  `${repoPath(file)} :: ${prop}.${slot} overrides ${why} :: ${value
                    .trim()
                    .replace(/\s+/g, ' ')
                    .slice(0, 80)}`
                );
            }
          }

          // Channel 3: a `.module.scss` handed to this element via `classNames`.
          // Resolved from the file's own imports rather than guessed from the
          // filename — `SelectMenu.tsx` imports `SelectMenu.module.scss`, but
          // nothing makes that a rule.
          if (/\bclassNames=\{/.test(head)) {
            for (const [, rel] of src.matchAll(
              /import\s+\w+\s+from\s+'(\.[^']*\.module\.s?css)'/g
            )) {
              const sheet = path.resolve(path.dirname(file), rel);
              if (!fs.existsSync(sheet)) continue;
              // 🔴 COMMENTS OUT FIRST. These rules are DISCUSSED at length in
              // the very files they govern — `NotificationsDrawer.module.scss`
              // explains its inset in a comment that names
              // `--safe-area-inset-top` four times. Unstripped, that prose
              // satisfies the `paysInset` check and the rule is scored
              // compliant with its declaration deleted. Caught by mutation:
              // removing that file's real inset left this sweep GREEN and only
              // the ledger noticed.
              const css = stripComments(fs.readFileSync(sheet, 'utf8'));
              for (const [slot, prop, why] of [
                ['content', 'padding', 'the drawer/modal content inset'],
                ['inner', isDrawer ? 'top' : 'padding', 'the drawer top inset / modal offset'],
              ] as const) {
                const ruleAt = css.search(new RegExp(`^\\.${slot}\\s*\\{`, 'm'));
                if (ruleAt === -1) continue;
                slotsSeen++;
                const rule = braceMatched(css, css.indexOf('{', ruleAt));
                if (new RegExp(`(^|[\\s;{])${prop}`, 'm').test(rule) && !paysInset(rule))
                  offenders.push(
                    `${repoPath(sheet)} :: .${slot} sets \`${prop}\` and outranks ${why}`
                  );
              }
            }
          }
          at = src.indexOf(tag, at + 1);
        }
      }
    }

    // 🔴 POSITIVE CONTROL. A zero-offender result is indistinguishable from a
    // sweep wired to nothing, so report the pair: the walk must have READ some
    // watched slots before its silence means anything. The floor is well below
    // the real count so removing one drawer does not fail this for the wrong
    // reason.
    expect(
      slotsSeen,
      'the sweep found NO watched slot on any Drawer/Modal, so its zero-offender verdict is a ' +
        'fact about the parser, not about the tree. Check the opening-tag walk, the brace ' +
        'matching and the stylesheet-import resolution before trusting it.'
    ).toBeGreaterThanOrEqual(8);
    expect(
      offenders,
      'these override the safe-area payment on the exact box the `@layer mantine` rules in ' +
        'globals.css pay it on, so that surface is UNPAID at that edge on every notched device. ' +
        'An inline `styles` object outranks a stylesheet, a Tailwind class in `classNames` is ' +
        'unlayered, and a `.module.scss` sits in `@layer modules` — all three win. Either move ' +
        'the padding to the `body` slot, which composes with the inset instead of replacing it, ' +
        'or fold the inset into the value with `max(…)` / `calc(…)` the way `SupportModal` and ' +
        '`NotificationsDrawer.module.scss` do.'
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
    // 🔴 NARROWED FROM A BLANKET `not.toMatch(/var\(--safe-area-inset-bottom\)/)`
    // OVER THE WHOLE FILE. That spelling banned the raw property ANYWHERE in
    // `AppFooter`, including a future use that has nothing to do with the
    // sticky bar's bottom edge — a raw inset is the CORRECT thing to read on
    // any box that is not the one the ad bar can stand in for. What actually
    // needs pinning is that the FOUR bar-geometry expressions read the
    // conditional property, so pin those four, whole and normalised, instead
    // of banning a substring. Whole-string per the same argument as
    // VIEWPORT_META_CONTENT: a fragment match is walkable by rewording.
    const normalised = footer.replace(/\s+/g, ' ');
    for (const [what, expr] of [
      ["the bar's height", 'h-[calc(var(--footer-height)+var(--safe-area-inset-bottom-unpaid))]'],
      ["the bar's padding-bottom", 'pb-[calc(0.25rem+var(--safe-area-inset-bottom-unpaid))]'],
      [
        "the floating cluster's bottom offset",
        'bottom-[calc(var(--footer-height)+var(--safe-area-inset-bottom-unpaid))]',
      ],
      [
        'the hide transform',
        'translateY(calc(var(--footer-height) + var(--safe-area-inset-bottom-unpaid)))',
      ],
    ] as const) {
      expect(
        normalised,
        `${what} no longer reads \`--safe-area-inset-bottom-unpaid\` in the recorded form:\n  ` +
          `${expr}\n\nThe footer bar is \`sticky bottom-0\` INSIDE the ScrollArea, so it is the ` +
          'viewport bottom only when `AdhesiveAd` is not rendering below it. All four ' +
          'expressions must describe the SAME bar height or the cluster lands inside the bar. ' +
          'If the change is deliberate, re-declare the new expression here.'
      ).toContain(expr);
    }
  });

  /**
   * The THIRD site of the same handover, and the one on the highest-traffic
   * mobile surface: tapping a gallery image opens `ImageDetailModal`, a
   * `fullScreen` `PageModal` whose own last in-flow child is an `<AdhesiveAd>`.
   * Both the modal-content rule and the ad bar pay the bottom inset, so
   * unhandled the bar floats ~34px off the physical edge over bare modal
   * background.
   *
   * 🔴 ASSERTED AS A RELATIONSHIP ACROSS THREE FILES, because no one of them
   * reads as broken alone and the CSS rule is the only place the three meet.
   * The scope of the `:has()` is the load-bearing half: `#__next:has(…)` also
   * matches when the SHELL's ad bar is behind a fullScreen modal that covers
   * it, and standing the modal down in that case would put its content under
   * the home indicator. Only the modal's own subtree distinguishes them.
   */
  it('a fullScreen modal that renders its own ad bar stands down, and only on its own subtree', () => {
    const css = read(GLOBALS_CSS);
    const detail = stripComments(
      read(path.join(REPO_ROOT, 'src/components/Image/DetailV2/ImageDetail2.tsx'))
    );
    const modal = stripComments(
      read(path.join(REPO_ROOT, 'src/components/Image/Detail/ImageDetailModal.tsx'))
    );

    expect(
      modal,
      '`ImageDetailModal` no longer renders `fullScreen`, so the fullScreen-modal inset rule ' +
        'and the stand-down below it no longer apply to the image detail surface at all. ' +
        'Re-derive which rule pays its bottom edge.'
    ).toContain('fullScreen');
    expect(
      detail,
      '`ImageDetail2` no longer renders an `AdhesiveAd`. The `:has([data-adhesive-ad])` ' +
        'stand-down in globals.css is now dead code that still reads as live — remove it, or ' +
        "find what pays the modal's bottom edge instead."
    ).toContain('<AdhesiveAd');
    expect(
      css,
      'the stand-down is keyed on `#__next` rather than on the modal content. That selector ' +
        'also matches while the SHELL ad bar is hidden BEHIND a fullScreen modal, and the modal ' +
        'would then pay nothing while genuinely being the viewport bottom.'
    ).toContain('.mantine-Modal-content[data-full-screen]:has([data-adhesive-ad])');
  });

  /**
   * The same handover asked one level further in. A route that nulls both
   * `header` and `footer` owns its own bottom edge — but the SAME components
   * are also reached from routes that keep the chrome, so the payment has to be
   * conditional there too, and on a WIDER condition: page content is covered by
   * the ad bar OR the footer bar, where the footer is covered only by the ad.
   *
   * 🔴 The asymmetry is the whole reason there are two properties, and it is
   * the thing most likely to be "simplified" into one. Zeroing `…-unpaid` from
   * `data-app-footer` would make the footer's own presence the reason it stops
   * paying — it renders on every route it could pay on, so it would pay on
   * none. This test pins the asymmetry, not just the existence of the rules.
   */
  it('the page-content half zeroes on EITHER bar, and never zeroes the footer on itself', () => {
    const css = read(GLOBALS_CSS);
    const footer = stripComments(read(APP_FOOTER));

    expect(
      footer,
      '`AppFooter` no longer marks itself with `data-app-footer`, so a chrome-less route cannot ' +
        'tell whether the footer bar is below its content and will pay an inset the footer is ' +
        'already paying.'
    ).toContain('data-app-footer');
    expect(
      css,
      'the `--safe-area-inset-bottom-page` default is gone, so page content on a route that ' +
        'nulls both header and footer pays nothing and sits under the home indicator.'
    ).toContain('--safe-area-inset-bottom-page: var(--safe-area-inset-bottom);');

    // Brace-matched so the two `#__next:has(…)` bodies are read whole; a
    // `[^}]*` match here would stop at the first inner `}` and could not tell
    // a one-property body from a two-property one, which is the exact
    // distinction under test.
    const bodyOf = (selector: string) => {
      const at = css.indexOf(selector);
      expect(at, `globals.css has no \`${selector}\` rule at all`).toBeGreaterThan(-1);
      return braceMatched(css, css.indexOf('{', at));
    };
    const adRule = bodyOf('#__next:has([data-adhesive-ad])');
    const footerRule = bodyOf('#__next:has([data-app-footer])');

    expect(adRule, 'the ad bar is below BOTH, so it must settle both questions.').toContain(
      '--safe-area-inset-bottom-unpaid: 0px;'
    );
    expect(adRule).toContain('--safe-area-inset-bottom-page: 0px;');
    expect(footerRule, 'the footer bar must stand the page content down.').toContain(
      '--safe-area-inset-bottom-page: 0px;'
    );
    expect(
      footerRule,
      'the `data-app-footer` rule also zeroes `--safe-area-inset-bottom-unpaid`. That property ' +
        "is what tells the FOOTER whether to pay, so this makes the footer's own presence the " +
        'reason it stops paying — it would then never pay on any route it renders on, and its ' +
        'links sit under the home indicator for every paid member and every moderator route.'
    ).not.toContain('--safe-area-inset-bottom-unpaid');
  });
});
