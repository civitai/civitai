import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `/apps/run/<slug>` must declare a NON-SCROLLING layout, and its host must
 * claim no height of its own. Node `unit` project — the GATING suite. The
 * `.browser.test.tsx` component suites DO run in CI, as the report-only
 * `preview / component-tests` status (`pnpm run test:component`), so a break
 * there is visible but does not block a merge. The coupling is pinned here for
 * that reason, and only MEASURED in `PageBlockHostScrollFit.browser.test.tsx`.
 *
 * WHAT BROKE. The route shipped a bare `export default function AppPage`, so it
 * inherited `AppLayout`'s default `scrollable: true` — a `ScrollArea` with
 * `overflow-y: auto`. Inside it `PageBlockHost` claimed
 * `min-height: calc(100dvh - 60px)`, which subtracts the site header and nothing
 * else. Sub-nav, its `mb-3`, the rewards banner, the footer and the adhesive ad
 * all sit inside or beside that scroll viewport, so the host was unconditionally
 * taller than the space it had: an outer scrollbar that scrolled only the
 * residue, beside the block's own scrollbar inside the iframe.
 *
 * 🔴 IT IS A CO-REQUISITE OF THREE LEGS, IN THREE PLACES. None is safe alone, so
 * the failure mode is someone reverting one during an unrelated change:
 *
 *   - `fit="fill"` WITHOUT `scrollable: false` → the host sits inside a layout
 *     that bounds nothing, so `flex: 1` has nothing to resolve against and the
 *     host is sized purely by `FILL_MIN_HEIGHT_PX` — a fixed 300px slab on a
 *     1080px screen. Broken, but quietly: it reads as a badly-sized block rather
 *     than a layout regression.
 *
 *     🔴 THIS FIGURE HAS BEEN WRONG TWICE, both times by editing the sentence
 *     instead of re-reading the code. It said "0px" (that is what `flex: 0`
 *     gives), then "~150px" (the iframe's intrinsic height — true before the
 *     floor existed, false the moment `FILL_MIN_HEIGHT_PX` was added in the same
 *     PR). Re-derive from the `fill` branch before touching this line.
 *   - `scrollable: false` WITHOUT `fit="fill"` → the host claims
 *     `100dvh - HEADER_HEIGHT_PX` again. The `overflow-hidden` chain sits ABOVE the run
 *     page's own wrapper, and that wrapper is `overflowY: 'auto'`, so the excess
 *     is SCROLLED, not clipped: a page scrollbar beside the block's own — the
 *     exact bug this PR removes. Measured 708px of host in a 600px wrapper,
 *     `USER_SCROLLABLE=true`.
 *
 *     🔴 THIS BULLET SAID "CLIPPED" FOR FIVE COMMITS, and it was TRUE when
 *     written at `4f78d37351` — the wrapper had no `overflowY` then. `c48ba4d029`
 *     added it and nobody re-derived the sentence. Two later rounds each declared
 *     the stale-figure class eradicated while this sat here, and one of them
 *     added cross-references POINTING AT this paragraph. Nothing clips in this
 *     layout; the wrapper can always scroll.
 *   - EITHER OF THOSE WITHOUT the run page's wrapper `Box` → same as the first
 *     case. This is the leg the browser suite structurally cannot see, because
 *     that suite builds its own fixture wrapper instead of importing the page.
 *
 * Presence checks alone pass a half-revert of the third leg and every mutation
 * that inverts rather than deletes, so the assertions below pin whole normalised
 * expressions as well.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RUN_PAGE = path.join(REPO_ROOT, 'src/pages/apps/run/[slug]/[[...path]].tsx');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/PageBlockHost.tsx');
const APP_LAYOUT = path.join(REPO_ROOT, 'src/components/AppLayout/AppLayout.tsx');

function read(file: string): string {
  // Prove the path before trusting a "no match": a comparison against an absent
  // operand reports SAME, not MISSING, and a renamed route would otherwise turn
  // every assertion below into a vacuous pass on an empty string.
  expect(fs.existsSync(file), `${path.relative(REPO_ROOT, file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip block + line comments so a rule can never be satisfied by prose ABOUT
 *  the rule — every one of these tokens is discussed at length in the comments
 *  it is being searched for in. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Collapse whitespace so an assertion pins the EXPRESSION, not its formatting. */
function norm(src: string): string {
  return src.replace(/\s+/g, ' ').trim();
}

/**
 * The chain of `{`-blocks enclosing `index`, outermost first, each labelled by the
 * text that introduced it (a selector or an at-rule).
 *
 * Deliberately a brace count, not a CSS parser — this only has to be right about
 * the stylesheets in this repo, and a parser would be a dependency to keep
 * correct. It is fooled by an unbalanced brace inside a string (`content: '}'`),
 * so callers must report the chain they computed rather than asserting a cause
 * from it; a chain that does not end in `:root` might mean the declaration moved,
 * or it might mean this walk got confused, and the failure message must not
 * pretend to know which.
 */
function enclosingBlocks(src: string, index: number): string[] {
  const stack: string[] = [];
  let last = 0;
  for (let i = 0; i < index; i++) {
    if (src[i] === '{') {
      stack.push(
        norm(src.slice(last, i))
          .replace(/^[;}]+/, '')
          .trim()
      );
      last = i + 1;
    } else if (src[i] === '}') {
      stack.pop();
      last = i + 1;
    }
  }
  return stack;
}

/**
 * Pull one balanced-looking source region out of a file by anchor regex, and
 * fail loudly if the anchor stops matching.
 *
 * 🔴 A regex that no longer matches must never read as "the rule is satisfied".
 * These assertions are the only thing standing between a later refactor and a
 * silent return of the bug, so an unmatched anchor is a FAILURE, not a skip.
 */
function region(src: string, anchor: RegExp, label: string): string {
  // `matchAll`, not `exec`: a first-match read silently grades the WRONG
  // occurrence if a second ever appears. That exact bug bit the `<main>`
  // assertion below (it read the scrollable branch instead of the no-scroll
  // one), so the lesson is applied at every site rather than the one that hurt.
  const all = [...src.matchAll(new RegExp(anchor.source, `${anchor.flags.replace('g', '')}g`))];
  expect(
    all.length,
    `${label}: expected exactly ONE match for ${anchor}, found ${all.length}. ` +
      'Zero means the anchor rotted — update the pin deliberately rather than deleting it. ' +
      'More than one means this pin is now ambiguous and is grading an arbitrary occurrence.'
  ).toBe(1);
  return norm(all[0][0]);
}

/** Shared explanation attached to every verbatim pin, so a failure tells the
 *  maintainer what it is and what to do rather than just diffing two strings. */
const PIN_HELP =
  'This is a DELIBERATE verbatim pin, not an incidental string match — a token check here ' +
  'passed a ternary inversion, a `flex: 0` and a deleted `overflow: hidden`. If you changed ' +
  'this block on purpose (including a pure reformat or a rename), update the expected string ' +
  'here in the same commit. If you did not, you have reintroduced the /apps/run double ' +
  'scrollbar or its 0-height cousin — see this file’s header.';

describe('the run page and its host agree on who owns the height', () => {
  it('the run page ships BOTH halves — non-scrolling layout AND a fill-fit host', () => {
    const src = code(read(RUN_PAGE));

    // Half 1: the route opts out of AppLayout's ScrollArea.
    expect(src).toMatch(/\bscrollable:\s*false\b/);
    // It has to reach the layout, which means going through `Page(...)` — a bare
    // default export silently takes every default back.
    expect(src).toMatch(/export\s+default\s+Page\s*\(/);

    // Half 2: the host is told not to claim a viewport-derived height.
    expect(src).toMatch(/\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/);
  });

  it('neither half can be reverted on its own', () => {
    const src = code(read(RUN_PAGE));
    const nonScrolling = /\bscrollable:\s*false\b/.test(src);
    const fillFit = /\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/.test(src);

    // The equivalence, not two independent presence checks. Half-reverting either
    // one regresses the page in a DIFFERENT direction (see this file's header —
    // neither direction is clipping), so this is what has to fail.
    expect(
      nonScrolling === fillFit,
      `\`scrollable: false\` (${nonScrolling}) and \`fit="fill"\` (${fillFit}) are a ` +
        'co-requisite on the run page — drop `fit="fill"` and the double scrollbar ' +
        'comes back (the page wrapper scrolls the excess); drop `scrollable: false` and ' +
        'the host becomes a fixed floor-height slab. See this file’s header.'
    ).toBe(true);
  });

  /**
   * 🔴 PIN THE WHOLE EXPRESSION, NOT FEATURES OF IT.
   *
   * A pre-merge mutation sweep on the first version of this file found 9 of 17
   * mutants surviving, because every assertion here was a presence check. The
   * three that matter, all invisible to a token grep:
   *
   *   - INVERT THE TERNARY (`fit === 'fill'` → `fit !== 'fill'`) — breaks EVERY
   *     surface at once: the run page gets the viewport calc back (the double
   *     scrollbar) and the dev tunnel + mod review get `fill` inside unbounded
   *     parents (the collapse the prop doc warns about). Every token a presence
   *     check looks for is still there.
   *   - `flex: 1` → `flex: 0` in the fill branch — the host stops growing at all.
   *   - DELETE (or comment out) `overflow: 'hidden'` on the reveal wrapper — the
   *     8px transform leak returns.
   *
   * Pinning the normalised text of the whole expression kills all three in one
   * assertion. The accepted cost is that a cosmetic reformat of these exact
   * blocks fails this test — that is the trade for a machine-checkable claim,
   * and the failure message says so. `code()` runs first, so commenting a line
   * out changes the normalised string exactly as deleting it does.
   */
  it("pins the host's `fit` branches verbatim — inversion, `flex: 0` and a dropped `overflow` all fail", () => {
    const src = code(read(HOST));
    expect(region(src, /\.\.\.\(fit === 'fill'[\s\S]*?\}\),/, 'fit ternary'), PIN_HELP).toBe(
      "...(fit === 'fill' ? { flex: 1, minHeight: FILL_MIN_HEIGHT_PX, } " +
        ": { height: '100%', minHeight: `calc(100dvh - ${HEADER_HEIGHT_PX}px)`, }),"
    );
  });

  it('pins the reveal wrapper, whose `overflow: hidden` is what confines the 8px transform', () => {
    const src = code(read(HOST));
    expect(
      region(src, /<Box\s+style=\{\{\s*position: 'relative',[\s\S]*?\}\}\s*>/, 'reveal wrapper'),
      PIN_HELP
    ).toBe(
      "<Box style={{ position: 'relative', flex: 1, display: 'flex', overflow: 'hidden', }} >"
    );
  });

  /**
   * 🔴 THE CO-REQUISITE IS A TRIO, NOT A PAIR — this is the third leg.
   *
   * The run page's own wrapper `Box` is what gives `fit="fill"` a growing flex
   * item to resolve against, and its `overflowY: 'auto'` is the scroll container
   * of last resort that makes `FILL_MIN_HEIGHT_PX` reachable instead of clipped.
   * Reverting it to the original `{ width: '100%' }` passed BOTH suites in the
   * pre-merge sweep while leaving the host sized only by its floor — measured
   * 300px host / 31px chrome / 269px iframe, whatever the viewport. The browser
   * test cannot see it because that test builds its own fixture wrapper rather
   * than importing the Next page.
   */
  it('pins the run page wrapper — the third leg the browser test structurally cannot see', () => {
    const src = code(read(RUN_PAGE));
    expect(
      region(src, /<Box\s+style=\{\{\s*display: 'flex',[\s\S]*?\}\}\s*>/, 'page wrapper'),
      PIN_HELP
    ).toBe(
      "<Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, " +
        "overflowY: 'auto', width: '100%', }} >"
    );
  });

  it('the host still DEFAULTS to `viewport`, so the other three mounters are untouched', () => {
    const src = code(read(HOST));
    // The dev tunnel and the mod-review preview mount inside scrolling ancestors
    // that bound nothing; flipping this default would collapse both.
    expect(src).toMatch(/\bfit\s*=\s*['"]viewport['"]/);
  });

  it('only the run page opts into `fill` — a new mounter must opt in deliberately', () => {
    // A directory walk, not a hand-kept list: the point is to notice a mounter
    // nobody told this test about.
    //
    // Scoped to files that actually mount `PageBlockHost`, because `fit` is not
    // a name this codebase owns — Mantine's `Image` has a `fit` prop too, so an
    // unrelated `fit="fill"` elsewhere in `src` would otherwise fail this test
    // and hand an unrelated team a maintenance tax.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const src = code(fs.readFileSync(full, 'utf8'));
          // Match the IMPORT, not the JSX tag: `import { PageBlockHost as Host }`
          // renders `<Host …>`, which a tag-only test misses entirely. (The
          // pre-scoping version caught it, over-broadly; this keeps the scoping
          // without reopening that hole.)
          if (!/\bPageBlockHost\b/.test(src)) continue;
          if (/\bfit=(["']fill["']|\{\s*['"]fill['"]\s*\})/.test(src))
            offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'src'));

    expect(offenders.sort()).toEqual(['src/pages/apps/run/[slug]/[[...path]].tsx']);
  });

  it('the layout premise this all rests on still holds', () => {
    // If `AppLayout`'s two branches ever stop differing this way, the fix above is
    // reasoning about a layout that no longer exists — and would fail SILENTLY,
    // since both halves would still be present in the source.
    const src = code(read(APP_LAYOUT));

    // The scrollable branch is a bounded, auto-overflow viewport…
    expect(src).toMatch(/scrollable\s*\?\s*\(\s*<ScrollArea/);
    // …and the non-scrollable branch clips instead of scrolling, all the way
    // down. Asserted as an unordered SET of classes, not as a literal string: a
    // prettier/tailwind-sort reorder is a no-op that would otherwise fail this.
    expect(src).toMatch(/no-scroll[^"']*flex[^"']*overflow-hidden/);

    // 🔴 `AppLayout` has TWO `<main>` elements — one per branch — so match ALL
    // of them and look for the no-scroll one. Reading only the first match found
    // the SCROLLABLE branch's `min-w-0 flex-1` and failed against the set this
    // test is about; a first-match read of a repeated pattern is its own bug
    // class, in the assertion as much as in an edit.
    //
    // 🔴 SORTED ARRAYS, NOT `Set`s. `expect([...]).toContainEqual(new Set([...]))`
    // does NOT deep-compare Set contents in Vitest — measured: it PASSES when
    // the expected set is absent entirely. A first draft of this assertion used
    // it and was silently vacuous, which the mutation sweep caught only because
    // dropping `overflow-hidden` survived. Sorting makes the comparison
    // order-independent without relying on Set equality.
    const mainClasses = [...src.matchAll(/<main className="([^"]*)">/g)].map((m) =>
      m[1].split(/\s+/).filter(Boolean).sort()
    );
    expect(mainClasses.length, 'expected both AppLayout branches to render a <main>').toBe(2);
    expect(mainClasses).toContainEqual(['flex', 'flex-1', 'flex-col', 'overflow-hidden'].sort());
  });

  /**
   * 🔴 THE HEADER HEIGHT HAS ONE SOURCE — THIS ENUMERATES THE LEDGER.
   *
   * What the previous guard (`HEADER_HEIGHT is still 60`) actually did: it
   * extracted the number from `AppHeader.tsx` and from the host's calc and
   * asserted they were equal. That was already a RELATIONSHIP, not a hardcoded
   * value, and it needed no retuning when the header moved — only its TITLE named
   * 60. An earlier draft of this comment claimed otherwise; that was wrong, and
   * the honest justification for replacing it is narrower: it could only ever see
   * TWO files, so it was blind to `globals.css` — the declaration that most of the
   * repo actually reads — and to a copy reappearing in any third file.
   *
   * So this walks the tree instead of opening four files by name. It fails when
   * the set of declarations GROWS (a second copy anywhere under `src/`), when it
   * SHRINKS to zero, or when the CSS and TS representations DIVERGE. It does not
   * care what the number is.
   *
   * 🔴 An earlier draft ASSERTED this ledger in prose while implementing spot
   * checks on four named files; an audit killed eight mutants against it —
   * a second declaration without a trailing `;`, one in `rem`, one in another
   * stylesheet, one in another `.ts`, the only one commented out, a consumer
   * applying `HEADER_HEIGHT_PX - 4`, and a consumer that kept only the IMPORT.
   * A description that reads as coverage while providing none is worse than no
   * guard, because it stops the next person looking. Hence the walk below, and
   * an application check that rejects arithmetic rather than a token-presence one.
   *
   * 🔴 WHAT IT STILL DOES NOT SEE, stated so this docstring is not the same lie in
   * a smaller size — and stated as MISSES, because an earlier version of this
   * paragraph closed with "everything here fails toward noise, never toward
   * silence", which an audit refuted with seven surviving mutants. These are
   * silence:
   *   - `.js/.jsx/.mjs` are not scanned (the extension filter below).
   *   - A TS copy declared as an object property, a class static or a destructured
   *     re-export: the scan matches a `const|let|var` binding only.
   *   - `setProperty(K, …)` where `K` is a variable rather than a literal.
   *   - `@property --header-height { initial-value: … }`, which is a declaration
   *     the CSS patterns do not model.
   * And these are noise (a false FAILURE, the safe direction): a CSS snippet
   * inside a TS string or a `type` key — `code()` strips comments, not strings —
   * and a declaration disabled with a TRAILING line comment, which `code()`'s
   * start-of-line-anchored rule does not strip.
   */
  it('the header height has ONE declaration under `src/`, and CSS and TS agree', () => {
    const constants = code(
      read(path.join(REPO_ROOT, 'src/shared/constants/app-layout.constants.ts'))
    );
    const declared = /export const HEADER_HEIGHT_PX = (\d+);/.exec(constants)?.[1];
    expect(
      declared,
      'HEADER_HEIGHT_PX declaration not found in app-layout.constants.ts — if it was renamed ' +
        'or derived, re-point this guard rather than deleting it: it is the only check binding ' +
        'the TS constant to the `--header-height` custom property.'
    ).toBeDefined();

    // ---- Walk `src/` once. Spot-checking named files is what the audited draft
    // did, and a copy reappearing in a file this test does not happen to open is
    // exactly the defect the consolidation removed.
    const SRC = path.join(REPO_ROOT, 'src');
    const files = fs
      .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(css|scss|ts|tsx)$/.test(f))
      .map((f) => path.join(SRC, f))
      // `readdirSync` yields directories too, and this repo has directories whose
      // names end in a matching extension — reading one throws EISDIR.
      .filter((f) => fs.statSync(f).isFile());
    // Guard the walk itself: a glob that matches nothing makes every assertion
    // below vacuously true, which is the reassuring-zero failure mode.
    expect(files.length, 'the src/ walk matched no stylesheets or TS files').toBeGreaterThan(1000);

    // ---- CSS side: exactly one `--header-height` declaration, anywhere.
    // Deliberately NOT anchored to `px;` — a value in `rem`, or with no trailing
    // semicolon, is still a declaration and still shadows. Capture the raw value
    // and judge it explicitly rather than letting a non-matching spelling read as
    // "no second declaration".
    const cssDecls: { file: string; value: string; blocks: string[] }[] = [];
    const tsDecls: { file: string; text: string }[] = [];
    for (const file of files) {
      // `code()` removes WHOLE-LINE (`^\s*//`) and BLOCK comments, so a declaration
      // commented out either of those ways counts as ABSENT — which it must, since
      // the audited draft read raw text and stayed green when the only declaration
      // was commented out. 🔴 It does NOT strip a TRAILING `//` comment (the rule is
      // anchored), so a declaration disabled that way is still counted. That
      // direction is fail-safe — a spurious FAILURE, never a spurious pass — and
      // stripping trailing `//` from CSS is not safe anyway (`url(https://…)`).
      const src = code(fs.readFileSync(file, 'utf8'));

      // Two spellings, because this repo uses both. Plain CSS (`--x: 60px`) and the
      // CSS-in-JS object form (`'--x': '60px'`), which is how ~240 custom-property
      // declarations under src/ are actually written — including a whole theme in
      // `src/shared/constants/chat-theme.ts` — plus the imperative `setProperty`.
      // Matching only the plain form made the test's title ("ONE declaration under
      // src/") wider than what it enforced.
      // 🔴 No `(?<!['"])` lookbehind on the plain form. An earlier draft had one to
      // stop the object form double-counting — but the object form cannot match
      // this pattern anyway (the quote sits between the name and the colon), so the
      // lookbehind bought nothing and silently DROPPED two real shapes: a style
      // attribute string (`style="--header-height: 80px"`) and a CSS snippet in a
      // string constant. Both are genuine shadowing declarations.
      const patterns = [
        /--header-height\s*:\s*([^;}\n]+)/g,
        // `\]?` so a COMPUTED key matches too — `['--header-height']: v` is the
        // standard TS idiom here, because `CSSProperties` rejects the plain key.
        /['"`]--header-height['"`]\s*\]?\s*:\s*([^,;}\n]+)/g,
        /setProperty\(\s*['"`]--header-height['"`]\s*,\s*([^)]+)\)/g,
      ];
      // 🔴 Skip THIS file on the CSS side too, for the same reason as the TS side
      // below: the patterns above are widened enough that a future failure message
      // quoting `--header-height: 60px` would match one of them and mint a phantom
      // second declaration inside the very file being edited. It self-matches zero
      // times today; that is one message-edit away from being untrue.
      const isSelf = path.resolve(file) === path.resolve(__filename);
      for (const re of isSelf ? [] : patterns) {
        for (const m of src.matchAll(re)) {
          cssDecls.push({
            file: path.relative(REPO_ROOT, file),
            value: m[1].trim().replace(/^['"`]|['"`]$/g, ''),
            // The chain of blocks enclosing this declaration, outermost first.
            // 🔴 NOT a brace-depth number: depth alone cannot tell `@layer theme`
            // (unconditional, and already used in this repo's globals.css) apart
            // from `@media` (conditional), and it calls a top-level `.some-scope`
            // block correct when the property is undefined everywhere outside it.
            // What matters is WHICH blocks enclose it, so record them and judge.
            blocks: enclosingBlocks(src, m.index),
          });
        }
      }
      // Any TS/TSX constant that looks like a private header-height copy.
      // 🔴 Skip THIS file: it necessarily contains the pattern it searches for
      // (the extraction regex above is a literal `const HEADER_HEIGHT_PX = …`),
      // so it matches itself. Excluded by path rather than by exempting tests
      // generally, so a copy in any OTHER test file is still caught.
      if (/\.tsx?$/.test(file) && path.resolve(file) !== path.resolve(__filename)) {
        for (const m of src.matchAll(/(?:const|let|var)\s+(HEADER_HEIGHT(?:_PX)?)\s*=/g)) {
          tsDecls.push({ file: path.relative(REPO_ROOT, file), text: m[1] });
        }
      }
    }

    expect(
      cssDecls.map((d) => `${d.file}: ${d.value}`),
      'expected exactly ONE `--header-height` declaration under src/. Zero means it was renamed ' +
        'or removed (or commented out) — re-point this guard rather than deleting it. More than ' +
        'one means the header height is conditional or duplicated, and binding it to a single TS ' +
        'constant is no longer a truthful claim.'
    ).toHaveLength(1);
    expect(cssDecls[0].file, 'the `--header-height` declaration moved out of globals.css').toBe(
      'src/styles/globals.css'
    );
    const chain = cssDecls[0].blocks;
    const chainText = chain.length ? chain.join(' > ') : '(no enclosing block)';
    // Conditional at-rules only. `@layer` is NOT one — it orders the cascade, it
    // does not gate it — and this repo already wraps rules in `@layer theme`.
    expect(
      chain.filter((b) => /^@(media|supports|container|scope)\b/.test(b)),
      `the \`--header-height\` declaration is inside a CONDITIONAL at-rule. Enclosing chain: ` +
        `${chainText}. Outside that condition the property is UNDEFINED, and every ` +
        '`calc(… - var(--header-height))` call site collapses at computed-value time.'
    ).toHaveLength(0);
    expect(
      chain.some((b) => /(^|,|\s):root\b/.test(b) || /^html\b/.test(b)),
      `the \`--header-height\` declaration is not on \`:root\` (or \`html\`). Enclosing chain: ` +
        `${chainText}. An element-scoped declaration leaves the property undefined everywhere ` +
        'outside that subtree, which is the same collapse. NOTE: this chain is computed by ' +
        'counting braces, so an unbalanced brace inside a string earlier in the file can also ' +
        'produce a wrong chain — check the file before assuming the declaration moved.'
    ).toBe(true);
    expect(
      cssDecls[0].value,
      'globals.css `--header-height` and `HEADER_HEIGHT_PX` have DIVERGED (or the unit changed). ' +
        'CSS cannot import the constant, so these two are kept in step by this assertion and ' +
        'nothing else.'
    ).toBe(`${declared}px`);

    // ---- TS side: exactly one declaration, and it is the exported constant.
    expect(
      tsDecls.map((d) => `${d.file}: ${d.text}`),
      'expected exactly ONE header-height constant under src/ — the exported HEADER_HEIGHT_PX. ' +
        'A second one is the duplication this consolidation removed; import the shared constant.'
    ).toHaveLength(1);
    expect(
      tsDecls[0].file,
      'the header-height constant moved out of app-layout.constants.ts. That is fine as a ' +
        'deliberate relocation — re-point this guard and the doc comment on the constant — but ' +
        'it must stay a SINGLE exported declaration.'
    ).toBe('src/shared/constants/app-layout.constants.ts');

    // ---- Consumers must APPLY it, not merely import it. A token-presence check
    // is satisfied by the import line alone, so renaming the constant or applying
    // `HEADER_HEIGHT_PX - 4` both survived the audited draft.
    //
    // 🔴 SCOPED TO THE `<header>` OPEN TAG, and it must be. Two earlier drafts got
    // this wrong in opposite directions. A `region()` pin anchored on
    // `style={{ height: … }}` was too brittle: a property reorder, a nested `}`
    // from a conditional spread, or ANY second inline height style anywhere in the
    // file broke it, reported through `region()`'s anchor assertion without
    // `PIN_HELP`. Relaxing it to an unanchored substring test over the whole file
    // then went too far the other way — `maxHeight: 40` added beside the constant
    // renders the header at 40px while every consumer still subtracts 60, and the
    // check stayed GREEN. One innocent-looking edit, silently wrong.
    //
    // Anchoring on `<header …>` keeps what was load-bearing — the height styles
    // that matter are the ones ON the header element, and there must be no other
    // height property fighting the constant — while staying immune to reordering
    // and to unrelated inline styles elsewhere in the component.
    const header = code(
      read(path.join(REPO_ROOT, 'src/components/AppLayout/AppHeader/AppHeader.tsx'))
    );
    const headerTag = region(header, /<header[\s\S]*?>/, 'AppHeader open tag');
    // Every height-family property on the tag, as a ledger. Exactly one, and it is
    // the shared constant applied unmodified.
    const heightProps = [...headerTag.matchAll(/([A-Za-z]*[Hh]eight)\s*:\s*([^,}]+)/g)].map(
      (m) => `${m[1]}: ${m[2].trim()}`
    );
    expect(
      heightProps,
      `${PIN_HELP} The <header> element must carry exactly ONE height property, set from the ` +
        'shared constant UNMODIFIED. Anything else — a hardcoded number, arithmetic ' +
        '(`HEADER_HEIGHT_PX - 4`), or a sibling `maxHeight`/`minHeight` clamping it — ' +
        'desynchronises the real header from every consumer that subtracts the constant, and ' +
        'the page-level double scrollbar comes back on the `viewport` surfaces.'
    ).toEqual(['height: HEADER_HEIGHT_PX']);

    // The surviving `viewport` surfaces (dev tunnel, mod review) subtract it.
    const host = code(read(HOST));
    expect(
      /minHeight:\s*'calc\(100dvh - \d+px\)'/.test(host),
      'PageBlockHost.tsx has gone back to a hardcoded px value in the viewport-fit calc.'
    ).toBe(false);
    expect(
      host.includes('`calc(100dvh - ${HEADER_HEIGHT_PX}px)`'),
      'PageBlockHost.tsx no longer interpolates HEADER_HEIGHT_PX into the viewport-fit calc.'
    ).toBe(true);
  });

  /**
   * 🔴 THE FLOOR'S VALUE BELONGS IN THE GATING TIER, NOT ONLY THE BROWSER ONE.
   *
   * `FILL_MIN_HEIGHT_PX` is the whole WCAG fix: too low and a short viewport
   * strands content behind `overflow-hidden`; too high and the page grows a
   * scrollbar beside the block's own on ordinary phones, which is THIS PR'S BUG
   * in a narrower window. Both guards on it were in
   * `PageBlockHostScrollFit.browser.test.tsx` — and that suite is REPORT-ONLY
   * (`preview / component-tests`) and historically ~16% flaky, i.e. exactly the
   * combination that trains people to click through. Measured: with the floor set
   * to 0, this gating file was 9/9 GREEN and only the non-blocking tier went red.
   *
   * So the band is asserted HERE too, by reading the declaration out of the
   * source the same way the `HEADER_HEIGHT` tripwire above does. The browser
   * suite still measures the CONSEQUENCE (a real host, laid out, at two viewport
   * sizes); this pins the DECISION so a merge cannot quietly change it.
   *
   * 🔴 THE BOUNDS ARE DELIBERATELY LITERALS HERE, NOT READ FROM THE SOURCE. A
   * band imported from (or regexed out of) `PageBlockHost.tsx` would be graded
   * against the same file it bounds, so a single edit could move the value and
   * its own limits together — the self-referential trap this whole guard exists
   * because of. The ARITHMETIC that justifies them lives on the constant's doc
   * comment; the NUMBERS live here (gating) and in
   * `PageBlockHostScrollFit.browser.test.tsx` (report-only). Both must admit a
   * value, so the tighter pair wins and drift is fail-safe.
   */
  it('`FILL_MIN_HEIGHT_PX` stays inside its documented band — in the BLOCKING tier', () => {
    const declared = /export const FILL_MIN_HEIGHT_PX = (\d+);/.exec(code(read(HOST)))?.[1];
    expect(
      declared,
      'FILL_MIN_HEIGHT_PX declaration not found in PageBlockHost.tsx — if it was renamed or ' +
        'derived, this guard must be re-pointed, not deleted: it is the only BLOCKING check on ' +
        'the floor value.'
    ).toBeDefined();

    const floor = Number(declared);
    // Lower: below this the block's own area (floor − ~31px AppBlockChrome) stops
    // being usable, which is the case the floor exists to prevent.
    // Upper: every px added widens the viewport population that sees two
    // scrollbars. 400 — the value this PR itself shipped one commit ago — is
    // outside the band on purpose.
    expect(floor).toBeGreaterThanOrEqual(280);
    expect(floor).toBeLessThanOrEqual(340);
  });
});
