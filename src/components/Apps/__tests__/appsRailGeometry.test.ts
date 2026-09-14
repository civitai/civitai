import fs from 'fs';
import path from 'path';
import ts from 'typescript';
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

  test('the layout renders BOTH classes, and NO media query decides a render', () => {
    /**
     * 🔴 THIS IS AN AST WALK, AND FOUR ROUNDS OF AUDIT SAY IT HAS TO BE.
     *
     * The previous four revisions of this guard were hand-rolled character scanners —
     * strip comments, mask string literals, brace-match `useEffect` bodies, compare
     * offsets. Every single one was bypassable, and each bypass was found only by the
     * round that audited the previous fix:
     *
     *   r5  an UNANCHORED regex proved token ORDER, never containment — a `matchMedia`
     *       in the render body survived at 12/12 green.
     *   r6  brace counting ran on raw text, so `const openBrace = '{';` inside the effect
     *       mis-sized the body and the render-body read was swallowed. Green again.
     *   r7  the literal mask had no unterminated-literal handling, so an apostrophe in
     *       JSX text (`Don't`) blanked everything up to the next quote — including a real
     *       read. Green again.
     *   r8  the `//` and `/*` branches ran in BOTH scans, so an ordinary route glob in
     *       page copy (`title="… src/*.tsx"`) blanked the rest of the file. Green again.
     *
     * The r8 defect is the one that settles the argument: this very file, ~100 lines
     * above, already documented that exact hazard for a DIFFERENT helper — "a
     * route-shaped glob in prose is ordinary in this codebase" — and the scanner was
     * written with that warning in view and still had the bug. A scanner that needs 60
     * lines of limits prose, and is wrong anyway, is the wrong instrument.
     *
     * An AST walk removes the whole class STRUCTURALLY rather than patching instances:
     * comments are TRIVIA and never become nodes, so no comment can hide or fabricate a
     * read; string contents are `StringLiteral`, never `Identifier`, so copy that merely
     * mentions "matchMedia" is not a violation (the r8 false positive) while
     * `window['matchMedia']` still is; and effect nesting is the tree itself, so there is
     * no brace matching to fool and no offsets to compare.
     *
     * `typescript` is already a devDependency and 20 test files in this repo parse source
     * this way, three of them as TSX — this is the house pattern, not new infrastructure.
     *
     * WHAT IT DOES NOT COVER, stated rather than discovered later: a name assembled at
     * runtime (`window['match' + 'Media']`). That needs constant folding. Its UNGUARDED
     * form already throws `ReferenceError: window is not defined` in
     * `__tests__/appsPageLayoutRender.test.ts`, which renders this component through
     * `react-dom/server`; only a `typeof window !== 'undefined'`-guarded, runtime-assembled
     * name escapes both, and nobody writes that.
     */
    const file = path.resolve(__dirname, '../AppsPageLayout.tsx');
    const source = fs.readFileSync(file, 'utf8');
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TSX
    );

    // Hooks whose callback runs AFTER paint — a media query read here cannot decide what
    // was rendered, so it cannot diverge between server and client.
    const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);
    // `matchMedia` is the raw API; the other three are this repo's hook wrappers, none of
    // which has a server answer. Banning them here keeps ONE rule in ONE place — the old
    // revision spelled the hook ban as a separate regex assertion, so the same rule lived
    // in two forms that could drift apart.
    const BANNED = new Set(['matchMedia', 'useMediaQuery', 'useIsMobile', 'useContainerQuery']);

    const classUses = new Set<string>();
    const violations: string[] = [];
    let readsInsideEffect = 0;

    const positionOf = (node: ts.Node) => {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
      return `${line + 1}:${character + 1}`;
    };

    const record = (name: string, node: ts.Node, effectDepth: number) => {
      if (effectDepth > 0) {
        readsInsideEffect += 1;
        return;
      }
      violations.push(`${name} at ${positionOf(node)}`);
    };

    const visit = (node: ts.Node, effectDepth: number) => {
      // An import of a banned hook is not itself a render-time read; flagging it would
      // report the wrong line. The USE is what this guard is about.
      if (ts.isImportDeclaration(node)) return;

      let depth = effectDepth;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const calleeName = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
        if (calleeName && EFFECT_HOOKS.has(calleeName)) depth = effectDepth + 1;
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'classes'
      ) {
        classUses.add(node.name.text);
      }

      // `window.matchMedia(…)`, `globalThis.matchMedia(…)`, a bare/destructured
      // `matchMedia`, and an alias assignment `const mm = window.matchMedia` all surface
      // here as an Identifier node. A comment mentioning the word does not — comments are
      // trivia. Neither does a string containing it.
      if (ts.isIdentifier(node) && BANNED.has(node.text)) record(node.text, node, depth);
      // …and the one non-Identifier spelling: `window['matchMedia']`.
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        BANNED.has(node.argumentExpression.text)
      ) {
        record(node.argumentExpression.text, node, depth);
      }

      node.forEachChild((child) => visit(child, depth));
    };
    visit(sourceFile, 0);

    // POSITIVE CONTROL on the walk itself: if the parse silently produced nothing, every
    // assertion below would pass vacuously over an empty tree.
    expect(
      classUses.size,
      'the AST walk found no `classes.*` usage — re-point this guard'
    ).toBeGreaterThan(0);

    // The stylesheet is only load-bearing if the component actually references it.
    expect(source).toContain('AppsPageLayout.module.scss');
    expect(classUses).toContain('rail');
    expect(classUses).toContain('railDrawerTrigger');
    expect(classUses).toContain('railRow');

    // 🔴 THE BAN. A media query outside an effect decides a render, and the server has no
    // `matchMedia` while a client ≥1300 returns true — the SSR/first-paint divergence this
    // surface has already paid for once.
    expect(
      violations,
      'a banned media-query read appears OUTSIDE a useEffect — it decides a render and ' +
        'diverges between server and client. The rail/drawer swap is a CSS media query on ' +
        'purpose; if you need the breakpoint in JS, read it in an effect that only CLOSES ' +
        'something, as the drawer-close effect does.'
    ).toEqual([]);

    // 🔴 SECOND POSITIVE CONTROL, and it is the one that stops this whole test going
    // vacuous. `violations` is empty both when the carve-out is correct AND when someone
    // deletes the drawer-close effect entirely. The layout is SUPPOSED to read
    // `matchMedia` exactly once, in an effect, to close a drawer left open across a resize
    // past 1300 — otherwise two `App sections` landmarks coexist and a focus trap sits
    // over a usable rail. Assert the carve-out still exists.
    expect(
      readsInsideEffect,
      'the drawer-close effect no longer reads `matchMedia` — an open drawer now survives ' +
        'a resize past APPS_RAIL_MIN_VIEWPORT, leaving two nav landmarks on screen'
    ).toBeGreaterThan(0);
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
