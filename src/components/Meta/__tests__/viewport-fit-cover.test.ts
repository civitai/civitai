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
 * 🔴 IT IS NOT A CLAIM THAT THIS SET IS COMPLETE. It is the set that was
 * enumerated and judged at-risk. Elements deliberately left out, with reasons,
 * are in the PR description — chiefly `AppHeader` (top inset; it carries an
 * inline height pinned to `HEADER_HEIGHT_PX` by a gating guard, so insetting it
 * is a refactor of the CSS/TS header-height binding, not a padding change) and
 * `PageBlockHost`'s `calc(100dvh - ${HEADER_HEIGHT_PX}px)`, whose guard in
 * `pageRunScrollContract.test.ts` asserts that EXACT substring and so goes red
 * on any inset added inside the calc.
 */
const INSET_CONSUMERS = [
  'src/components/Ads/AdhesiveAd.tsx',
  'src/components/AppLayout/AppFooter.tsx',
  'src/components/Apps/ReviewActionBar.tsx',
  'src/components/Chat/ChatPortal.tsx',
  'src/components/Consent/ConsentBanner.tsx',
  'src/components/Csam/CsamImageSelection.tsx',
  'src/components/ImageGeneration/GeneratedOutputLightbox.tsx',
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
