import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';
import {
  APPS_RAIL_COLLAPSED_WIDTH,
  APPS_RAIL_COOKIE,
  APPS_RAIL_DEFAULT_STATE,
  APPS_RAIL_GAP,
  APPS_RAIL_MIN_VIEWPORT,
  APPS_RAIL_STORAGE_KEY,
  APPS_RESERVED_SCROLLBAR,
  appsRailChromeWidth,
  parseAppsRailState,
} from '~/components/Apps/appsRailGeometry';
import { SUBNAV_STICKY_GAP } from '~/hooks/useSubnavBottom';
import {
  LISTING_FOUR_COLUMN_MIN_WIDTH,
  listingCardWidthAt,
  listingGridColumnsAt,
} from '~/components/Apps/appListingGrid';
// 🔴 THE PARSER PRODUCTION ACTUALLY RUNS. `_app`'s `getInitialProps` calls
// `parseCookies(getCookies(ctx))`, so this zod schema — not any helper in the rail's own
// module — is what decides the SSR seed. An earlier revision of this file tested a
// second, hand-rolled header parser that had zero production callers; see the note where
// it used to live in `appsRailGeometry.ts`.
import { parseCookies } from '~/shared/utils/cookies';

/**
 * `/apps/*` LEFT RAIL — geometry constants, the CSS seam, and the cookie parser.
 * Blocking `unit` project.
 *
 * 🔴 THE SEAM IS THE LOAD-BEARING TEST HERE, for the same reason the store grid's is:
 * `APPS_RAIL_MIN_VIEWPORT` is a TypeScript value that nothing at runtime reads. The
 * responsive switch is applied by `AppsPageLayout.module.scss`, whose `@media` thresholds
 * are hand-written CSS literals. Each half is individually correct-looking while
 * disagreeing with the other, and neither throws — the rail would simply appear at a
 * different width than every constant and comment in the codebase says it does.
 */

describe('the rail costs what the ladder and the layout think it costs', () => {
  test('276px open, 72px collapsed', () => {
    expect(appsRailChromeWidth(false)).toBe(276);
    expect(appsRailChromeWidth(true)).toBe(72);
    expect(APPS_RAIL_COLLAPSED_WIDTH).toBe(56);
  });

  test('🔴 the rail`s SIDE gap is the same constant as its TOP gap', () => {
    // The rail is pinned to `subnavBottom + SUBNAV_STICKY_GAP` and separated from the body
    // by `APPS_RAIL_GAP`. If those two drift the rail sits in an asymmetric corner.
    // `appsRailGeometry` deliberately does NOT import `useSubnavBottom` — that would pull
    // React into a module `appListingGrid.ts` reads — so the equality is asserted rather
    // than enforced by construction, which is what makes this test load-bearing rather
    // than tautological.
    expect(APPS_RAIL_GAP).toBe(SUBNAV_STICKY_GAP);
    expect(APPS_RAIL_GAP).toBe(16);
  });

  test('🔴 the four-column store rung has ZERO margin, and this is where that is stated', () => {
    // ⚠️ `expect(APPS_RESERVED_SCROLLBAR).toBe(10)` WAS THE WHOLE TEST HERE, AND IT
    // ASSERTED A LITERAL AGAINST ITSELF — it cannot fail for the reason that matters, which
    // is what the allowance BUYS. An audit priced it: the grid at a 2560 viewport is
    // `2252 − S`, against a four-column rung of 2242, so four columns arrive **iff S ≤ 10**.
    // There is no slack at all at the one viewport the rung was derived for.
    // 🔴 AND THE FIRST REPLACEMENT FOR IT WAS JUST AS INERT — recorded because the second
    // attempt is only credible with the first one's failure written down. It defined
    // `gridAt2560(S) = CONTAINER − S − GUTTER − railChrome(false)`, which is
    // CHARACTER-FOR-CHARACTER the definition of `LISTING_FOUR_COLUMN_MIN_WIDTH`, and then
    // asserted the two were equal. That is `X === X` for ANY values of the four inputs.
    // Mutation-proven by a delta audit: widening `APPS_RAIL_WIDTH` 260 → 300 (which
    // silently moves the rung to 2202 and makes "zero margin at 2560" a claim about a
    // different number) left it GREEN; so did `APPS_PAGE_CONTAINER_WIDTH` 2560 → 2600.
    //
    // So the rung is pinned as an INDEPENDENTLY WRITTEN LITERAL. 2242 is typed out here
    // and derived there; that is the only arrangement in which moving any input can fail.
    expect(
      LISTING_FOUR_COLUMN_MIN_WIDTH,
      'the four-column rung moved. It is derived from the container, the scrollbar ' +
        'allowance, the gutter and the RAIL WIDTH — so a rail-width change silently ' +
        'retunes the store ladder. Re-read the cost table on LISTING_GRID_SPAN before ' +
        're-baselining this number.'
    ).toBe(2242);
    expect(APPS_RESERVED_SCROLLBAR).toBe(10);

    // THE MARGIN, NAMED: exactly zero — the widest grid a 2560 viewport can yield with
    // the rail open, minus the rung, against literals on both sides.
    expect(2560 - 10 - 32 - 276).toBe(2242);
    expect(2560 - 10 - 32 - 276 - 2242).toBe(0);

    // …and the cliff is one pixel away, in the one direction a real platform can move it.
    expect(listingGridColumnsAt(2242), 'S=10 — the allowance this repo assumes').toBe(4);
    expect(
      listingGridColumnsAt(2241),
      'S=11 — an 11px thin gutter and a 2560 monitor renders THREE 736.3px cards instead ' +
        'of four 548.5px ones. (A WIDER SCROLLBAR is the only mechanism: OS scaling and ' +
        'browser zoom change the CSS viewport, not S.)'
    ).toBe(3);
    expect(listingCardWidthAt(2241, 3)).toBeCloseTo(736.33, 2);

    // 🔴 AND WHY THIS LIVES IN THE NODE TIER RATHER THAN THE BROWSER ONE. Measured in the
    // pinned `chrome-headless-shell`: `scrollbar-width: thin`, `auto` and `none` ALL report
    // a 0px gutter, with and without `--disable-features=OverlayScrollbar`. Every browser
    // test therefore runs at S=0, so the reserving platform — the one this rung was placed
    // for — is structurally invisible to that tier. Arithmetic is the only instrument this
    // repo has for it, so the arithmetic is asserted rather than assumed.
    expect(listingGridColumnsAt(2252), 'S=0 — every browser test on this repo').toBe(4);
  });
});

describe('🔴 SEAM — the stylesheet switches at exactly APPS_RAIL_MIN_VIEWPORT', () => {
  const STYLES = path.resolve(__dirname, '../AppsPageLayout.module.scss');

  /**
   * 🔴 READ LAZILY, INSIDE EACH TEST. A `readFileSync` in the describe body throws during
   * COLLECTION when the stylesheet is missing, and Vitest reports that as `Tests no
   * tests` — the reassuring-zero shape — rather than as a failure naming the missing file.
   * A deleted stylesheet is precisely the defect this seam exists to catch.
   */
  function readStyles(): string {
    if (!fs.existsSync(STYLES)) {
      throw new Error(
        `the rail's stylesheet is missing at ${STYLES} — the 1300px switch is declared in ` +
          'TypeScript and applied there, so without it the rail renders at every width.'
      );
    }
    return fs.readFileSync(STYLES, 'utf8');
  }

  /** Comments stripped FIRST: the stylesheet's own prose names 1300 verbatim. */
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** Every `@media (min-width: Npx)` threshold, in file order. */
  const thresholds = (css: string) =>
    [...css.matchAll(/@media\s*\(\s*min-width:\s*(\d+)px\s*\)/g)].map((m) => Number(m[1]));

  test('POSITIVE CONTROL — the parser finds rules, and the comment strip did not eat them', () => {
    const source = readStyles();
    const code = strip(source);
    expect(thresholds(code).length, 'no @media rules parsed out of the stylesheet').toBeGreaterThan(
      0
    );
    // The strip really removed the prose: `276px` appears only in a docstring here and can
    // never be a media threshold, so it cannot stop being a valid witness.
    expect(source, 'the comment-strip control lost its witness').toContain('276px');
    expect(code).not.toContain('276px');
    // …and 1300 IS named in the prose, which is the thing the strip exists for: an
    // unstripped scan would find it with every real rule deleted.
    expect(source).toContain('1300');
  });

  test('🔴 every media threshold EQUALS the constant — no rule without a constant', () => {
    const found = thresholds(strip(readStyles()));
    expect(
      [...new Set(found)],
      'AppsPageLayout.module.scss and APPS_RAIL_MIN_VIEWPORT disagree. The stylesheet is ' +
        'what actually decides whether the rail renders; the constant is what every ' +
        'geometry test and docstring reasons about. Move both or neither.'
    ).toEqual([APPS_RAIL_MIN_VIEWPORT]);
  });

  test('🔴 the rail and the drawer trigger are MUTUALLY EXCLUSIVE, in both directions', () => {
    // The property that makes the hydration argument true: both shapes are always
    // RENDERED and the browser picks one, so exactly one must be displayed at any width.
    // A stylesheet that showed the rail at ≥1300 but forgot to hide the drawer trigger
    // would render two navigations side by side and no TypeScript check could see it.
    const code = strip(readStyles());
    expect(code).toMatch(/\.rail\s*\{[^}]*display:\s*none/);
    expect(code).toMatch(/\.railDrawerTrigger\s*\{[^}]*display:\s*flex/);
    const wide = code.slice(code.indexOf('@media'));
    expect(wide).toMatch(/\.rail\s*\{[^}]*display:\s*block/);
    expect(wide).toMatch(/\.railDrawerTrigger\s*\{[^}]*display:\s*none/);
  });

  test('the layout renders BOTH classes (a stylesheet nothing references changes no pixels)', () => {
    // 🔴 LINE COMMENTS ARE STRIPPED **FIRST**, AND THE ORDER IS NOT A STYLE CHOICE.
    // `AppsPageLayout.tsx` contains the line comment "…so `/apps/*` starts directly under
    // the global header…". A block-comment-first strip — the order most of this repo's
    // source scanners use — reads that `/*` as an OPENING delimiter and deletes
    // everything up to the next `*/`, which is ~80 lines later. Measured here: it removed
    // the `classes.railRow` render entirely and this assertion failed against completely
    // correct code. A route-shaped glob in prose is ordinary in this codebase, so the
    // hazard is general rather than specific to this file.
    const stripComments = (s: string) =>
      s.replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    // The control for that ordering, on a fixture rather than on the file under test — a
    // control built from the artifact it is validating cannot fail independently of it.
    expect(stripComments('// a `/*` in prose\nconst keep = 1;\n')).toContain('const keep = 1;');
    expect(stripComments('/* real block */ const also = 2;')).toContain('const also = 2;');
    expect(stripComments('/* real block */ const also = 2;')).not.toContain('real block');

    const layout = stripComments(
      fs.readFileSync(path.resolve(__dirname, '../AppsPageLayout.tsx'), 'utf8')
    );
    expect(layout).toContain('AppsPageLayout.module.scss');
    expect(layout).toContain('classes.rail');
    expect(layout).toContain('classes.railDrawerTrigger');
    expect(layout).toContain('classes.railRow');
    // 🔴 AND NO MEDIA-QUERY HOOK DECIDES WHAT RENDERS, which is the thing the stylesheet
    // exists instead of. `useMediaQuery` has no server answer, so a hook-driven swap is
    // the hydration mismatch this surface has already paid for once.
    expect(layout).not.toMatch(/useMediaQuery|useIsMobile|useContainerQuery/);

    // ⚠️ THE LAYOUT DOES READ `matchMedia` — ONCE, IN AN EFFECT, AND ONLY TO CLOSE THE
    // DRAWER. That is deliberate and is NOT the banned shape: the rail/drawer swap is a
    // CSS media query, so React never learns the breakpoint was crossed and an OPEN drawer
    // survives a resize past 1300 — leaving two `App sections` landmarks and a focus trap
    // over a usable rail. An effect that can only CLOSE something cannot decide a render,
    // so it cannot reintroduce an SSR/first-paint divergence. Pinned as BOTH halves, so
    // neither the ban above nor this carve-out can be widened into the other: EVERY
    // `window.matchMedia` read must live inside a `useEffect` body, and none may appear in
    // the returned JSX.
    //
    // 🔴 THIS HALF IS A CONTAINMENT CHECK, NOT A REGEX, AND THE DIFFERENCE IS THE WHOLE
    // POINT. It used to read `/useEffect\(\(\) => \{[\s\S]*?window\.matchMedia\(/`, which
    // is UNANCHORED: it is satisfied by any `useEffect(() => {` appearing anywhere before
    // any `window.matchMedia(`, and so establishes only that the two tokens occur in that
    // ORDER — never that one CONTAINS the other. Measured: injecting
    // `window.matchMedia('(min-width: 1300px)').matches` into the component's RENDER BODY
    // (after the effects, before the JSX) left this file fully GREEN at 12/12, while the
    // JSX half correctly reds. A render-body read is exactly the banned shape — the server
    // has no `matchMedia` and a client ≥1300 returns true — so the guard was reading as
    // cover for the hydration class while providing none for it.
    //
    // 🔴 BRACE COUNTING RUNS ON A LITERAL-MASKED COPY, AND SKIPPING THAT MASK IS A
    // MEASURED BYPASS OF THIS ENTIRE GUARD. An earlier revision counted braces on
    // `layout` and claimed in this comment that "the only braces left inside an effect
    // body are the balanced `${…}` of a template literal". Both halves were false: the
    // effect body already contains two ordinary block braces (`if (mql.matches) {` and the
    // `onChange` arrow), and `stripComments` above only removes LINE-START `//` comments,
    // so a trailing comment survives intact. Adding ONE line of perfectly ordinary code
    // inside the effect — `const openBrace = '{';`, or a trailing comment mentioning a
    // `{` — raises `depth`, so the body-end scan runs past the effect's real `}` and a
    // render-body `matchMedia` then reports as "inside an effect body". Measured: with
    // either of those plus the banned render-body read, this file was GREEN at 12/12.
    // The `unbalanced braces` assertion does not fire either, because depth still reaches
    // zero — just later.
    //
    // So: blank the CONTENTS of comments and string/template literals, preserving length
    // so every offset below still indexes the real file.
    //
    // ⚠️ KNOWN LIMIT: regex literals are NOT masked (telling `/` division from a regex
    // needs a real tokeniser). `AppsPageLayout.tsx` contains none today, and the
    // `endsBeforeJsx` assertion below is the backstop — a runaway body from ANY cause,
    // masked or not, overshoots the JSX and reds there.
    const maskLiterals = (src: string) => {
      const out = src.split('');
      const blank = (at: number) => {
        if (out[at] !== '\n') out[at] = ' ';
      };
      let i = 0;
      while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
          while (i < src.length && src[i] !== '\n') blank(i++);
          continue;
        }
        if (c === '/' && next === '*') {
          blank(i++);
          blank(i++);
          while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) blank(i++);
          if (i < src.length) {
            blank(i++);
            blank(i++);
          }
          continue;
        }
        if (c === '"' || c === "'" || c === '`') {
          i++; // keep the opening quote itself
          while (i < src.length) {
            if (src[i] === '\\') {
              blank(i++);
              if (i < src.length) blank(i++);
              continue;
            }
            if (src[i] === c) break;
            blank(i++);
          }
          i++; // skip the closing quote
          continue;
        }
        i++;
      }
      return out.join('');
    };

    // Controls on FIXTURES, not on the file under test — a control built from the artifact
    // it validates cannot fail independently of it. Each asserts the mask both blanks the
    // hazard and preserves length/real code.
    const braceInString = `const a = '{'; if (x) { y(); }`;
    expect(maskLiterals(braceInString)).toHaveLength(braceInString.length);
    expect(
      (maskLiterals(braceInString).match(/\{/g) ?? []).length,
      'the brace inside the string literal survived the mask'
    ).toBe(1);
    const braceInComment = `doIt(); // note a { here\nnext();`;
    expect(
      (maskLiterals(braceInComment).match(/\{/g) ?? []).length,
      'the brace inside the trailing comment survived the mask'
    ).toBe(0);
    expect(maskLiterals(braceInComment)).toContain('doIt();');
    expect(maskLiterals(braceInComment)).toContain('next();');

    const scan = maskLiterals(
      fs.readFileSync(path.resolve(__dirname, '../AppsPageLayout.tsx'), 'utf8')
    );
    // ⚠️ THE RECOGNISER IS NARROWER THAN THE SENTENCE ABOVE, AND THAT IS RECORDED RATHER
    // THAN PAPERED OVER. `effectOpen` matches the LITERAL spelling `useEffect(() => {`.
    // A read inside `useEffect(function () {…})`, `useEffect(async () => {…})`, a
    // multi-line `useEffect(\n  () => {`, or a `useLayoutEffect` is a legitimate effect
    // this loop would report as "NOT inside any useEffect body" — a false positive with a
    // confidently wrong diagnosis. It is not a false NEGATIVE, so the ban cannot be
    // silently escaped by respelling; and if respelling removes the only match, the
    // `effectBodies.length > 0` control below fires with its own self-diagnosing message
    // rather than passing vacuously.
    //
    // Measured in the ONLY file this guard scans — `AppsPageLayout.tsx` — which holds
    // exactly ONE `useEffect(() => {` and zero `useEffect(function`, `useEffect(async` or
    // `useLayoutEffect`. So the narrow spelling costs nothing here. Widen it when that
    // stops being true; do not widen it speculatively, because every spelling added is
    // another brace-matching shape to validate.
    //
    // ⚠️ Scope that claim to THIS file, not to `src/`. Grepping the tree for those
    // spellings returns hits from THIS COMMENT — the prose naming the hazard is itself a
    // match — so a repo-wide count here would be measuring its own text. The guard reads
    // one file; the count that means anything is the one for that file.
    const effectBodies: Array<[number, number]> = [];
    const effectOpen = /useEffect\(\(\) => \{/g;
    for (let m = effectOpen.exec(scan); m; m = effectOpen.exec(scan)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const bodyStart = i;
      for (; i < scan.length && depth > 0; i++) {
        if (scan[i] === '{') depth++;
        else if (scan[i] === '}') depth--;
      }
      expect(depth, 'unbalanced braces while scanning a useEffect body').toBe(0);
      effectBodies.push([bodyStart, i]);
    }
    expect(
      effectBodies.length,
      'no `useEffect(() => {` found — re-point this guard'
    ).toBeGreaterThan(0);

    const reads: number[] = [];
    const mediaRead = /window\.matchMedia\(/g;
    for (let m = mediaRead.exec(scan); m; m = mediaRead.exec(scan)) reads.push(m.index);
    // Positive control: if this ever finds nothing, the loop below is vacuous and would
    // pass over a file that had removed the carve-out entirely.
    expect(reads.length, 'no `window.matchMedia(` found — re-point this guard').toBeGreaterThan(0);
    // ⚠️ ANCHORED ON `<Container`, NOT ON `return (`. The FIRST `return (` in this file is
    // the drawer effect's own cleanup (`return () => mql.removeEventListener(...)`), so
    // slicing there covers 60 lines of hook body and docblock as well as the JSX. That is
    // a superset today — it passes, and is not a false negative — but a SECOND legitimate
    // effect reading `matchMedia` would red it with the message "a media query reached
    // the rendered tree", diagnosing a non-defect. The component's JSX is the only thing
    // this rule is about, and `<Container` is where it starts.
    //
    // 🔴 THIS CHECK RUNS BEFORE THE CONTAINMENT LOOP BELOW, AND THE ORDER IS DELIBERATE.
    // A `matchMedia` in the JSX is also outside every effect body, so the containment loop
    // would catch it too — but it would report it with the containment message, and this
    // assertion would never execute. A guard that can only ever be pre-empted by another
    // guard is dead coverage: it reads as a second check and cannot fail independently.
    // Ordering it first gives each half its own killing mutant and its own diagnosis —
    // JSX read → "a media query reached the rendered tree"; render-body read → the
    // containment message. Both verified by mutation.
    const jsxStart = scan.indexOf('<Container');
    expect(jsxStart, 'the rendered tree was not found — re-point this guard').toBeGreaterThan(-1);
    expect(scan.slice(jsxStart), 'a media query reached the rendered tree').not.toMatch(
      /matchMedia/
    );

    // 🔴 BACKSTOP ON THE BRACE MATCHER ITSELF. Every effect is declared before the
    // component returns, so every effect body must END before the JSX begins. A body that
    // overshoots means the depth counter was fooled — by an unmasked regex literal, or by
    // any construct this scanner does not model — and an overshooting body is exactly what
    // swallows a render-body read and silently disarms the containment check below. This
    // fires on the CAUSE rather than on one known trigger, so it holds for bypasses that
    // have not been thought of.
    for (const [start, end] of effectBodies) {
      expect(
        end,
        `a useEffect body starting at ${start} ends at ${end}, past the JSX at ${jsxStart} — ` +
          'the brace matcher was fooled, so the containment check below cannot be trusted'
      ).toBeLessThan(jsxStart);
    }

    for (const at of reads) {
      expect(
        effectBodies.some(([start, end]) => at >= start && at < end),
        `a \`window.matchMedia\` read at offset ${at} is NOT inside any useEffect body — ` +
          'a media query outside an effect decides a render and diverges between server and client'
      ).toBe(true);
    }
  });
});

describe('the persisted state fails OPEN, always', () => {
  test('the default is open, and every unknown value resolves to it', () => {
    expect(APPS_RAIL_DEFAULT_STATE).toBe('open');
    for (const value of [undefined, null, '', 'open', 'OPEN', 'Collapsed', 'true', '1', 'x']) {
      expect(parseAppsRailState(value), `"${String(value)}"`).toBe('open');
    }
    // …and the ONE value that collapses it, so the parser is not a constant.
    expect(parseAppsRailState('collapsed')).toBe('collapsed');
  });

  test('the cookie and the localStorage key are ONE name', () => {
    // Two literals would let the SSR seed and the client store drift apart, which
    // presents as "the rail forgets, but only after a reload".
    expect(APPS_RAIL_STORAGE_KEY).toBe(APPS_RAIL_COOKIE);
    expect(APPS_RAIL_COOKIE).toBe('apps-rail');
  });

  test('🔴 the LIVE parser: a present cookie seeds, an ABSENT one stays undefined', () => {
    // 🔴 THE `undefined` HALF IS THE WHOLE TEST, AND IT IS THE BUG THIS FILE SHIPPED.
    // `appsRail` was `.catch('open').default('open')`, which can never return undefined —
    // so `_app` always handed `AppsRailProvider` a real seed, `useAppsRail`'s
    // `seed !== null` short-circuit fired on every render, and the `localStorage` fallback
    // three docstrings describe was DEAD CODE in production. Nothing caught it: the only
    // test reaching the adoption branch went through the provider-less path, which `_app`
    // never takes. It is now `.optional().catch('open')`, and this asserts the
    // discriminator survives.
    expect(parseCookies({ 'apps-rail': 'collapsed' }).appsRail).toBe('collapsed');
    expect(parseCookies({ 'apps-rail': 'open' }).appsRail).toBe('open');
    // …and the ABSENT case, which is what licenses the localStorage fallback.
    expect(parseCookies({}).appsRail).toBeUndefined();
    expect(parseCookies({ mode: 'All' }).appsRail).toBeUndefined();
  });

  test('🔴 the LIVE parser still fails OPEN on garbage, rather than to undefined', () => {
    // The other direction, and it is not the same claim: a PRESENT-but-unparseable value
    // must not be read as "no cookie", or a corrupted cookie would silently hand control
    // to `localStorage` instead of failing open. `.catch('open')` is what keeps those two
    // apart; dropping it in favour of a bare `.optional()` passes the test above and
    // breaks this one.
    for (const value of ['COLLAPSED', 'true', '1', 'x', '']) {
      expect(parseCookies({ 'apps-rail': value }).appsRail, `"${value}"`).toBe('open');
    }
  });

  test('the cookie NAME the live parser reads is the one the rail writes', () => {
    // The seam the deleted hand-rolled parser used to stand in for: `persistAppsRailState`
    // writes `APPS_RAIL_COOKIE`, and `parseCookiesObj` must read that same key. Two
    // literals here would be exactly the drift this asserts against.
    expect(APPS_RAIL_COOKIE).toBe('apps-rail');
    expect(parseCookies({ [APPS_RAIL_COOKIE]: 'collapsed' }).appsRail).toBe('collapsed');
    // A cookie whose name merely CONTAINS the rail's is a different cookie — the
    // substring trap a `includes`-based parser walks into.
    expect(parseCookies({ 'not-apps-rail': 'collapsed' }).appsRail).toBeUndefined();
  });
});
