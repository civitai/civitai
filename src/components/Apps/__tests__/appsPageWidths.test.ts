import fs from 'fs';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import {
  APPS_CONTAINER_GUTTER,
  APPS_FULL_BLEED_PAGES,
  APPS_FULL_MEASURE_PAGES,
  APPS_NARROW_TABLE_MEASURE,
  APPS_PAGE_CONTAINER_WIDTH,
  APPS_PAGE_MEASURES,
  APPS_READABLE_MEASURE,
  APPS_REDIRECT_ONLY_PAGES,
  APPS_TWO_COLUMN_DETAIL_MEASURE,
} from '~/components/Apps/appsPageWidths';
import * as widthsModule from '~/components/Apps/appsPageWidths';
import { LISTING_GRID_SPAN, LISTING_STORE_CONTAINER_SIZE } from '~/components/Apps/appListingGrid';
import {
  SUBMISSIONS_CONTAINER_CHROME,
  SUBMISSIONS_TABLE_MIN_WIDTH,
} from '~/components/Apps/submissionsTable';

/**
 * `/apps/*` geometry pins (blocking `unit` project).
 *
 * The model: ONE container width for every route, plus an optional CONTENT MEASURE
 * applied inside the body. It replaced a per-route CONTAINER width, which put the
 * shared sub-nav inside a per-page box and made the tab strip move horizontally
 * between routes.
 *
 * The RENDERED proof of the alignment lives in
 * `AppsPageLayout.chromeAlignment.browser.test.tsx` (browser-mode, report-only). This
 * file pins the CONSTANTS and the route taxonomy in the tier that actually gates.
 */

/**
 * Tags a page's default export may render WITHOUT mounting the shared chrome: the
 * access-denied leaf and the document-head element that is a sibling of the layout
 * rather than a substitute for it.
 */
const CHROME_EXEMPT_TAGS = new Set(['Meta', 'NotFound']);

/**
 * Components a page may render INSTEAD of mounting the chrome itself, because they mount
 * it one level down. `/apps/submit`'s `?edit=<listingId>` branch is the only such case:
 * it returns `<AppsSubmitEditView …/>`, and that component owns its own `AppsPageLayout`
 * (nesting a second one inside it would double the chrome).
 *
 * 🔴 EVERY ENTRY IS VERIFIED, NOT TRUSTED. An allowlist is exactly where a real orphan
 * would hide — "it's fine, that component handles it" is the sentence that stops anyone
 * looking. The test below parses each delegate's own source and fails if it does not in
 * fact render `AppsPageLayout`, so adding a name here cannot silence the guard.
 */
const CHROME_DELEGATES: Record<string, { file: string; exportName: string }> = {
  AppsSubmitEditView: {
    file: 'src/components/Apps/AppsSubmitEditView.tsx',
    exportName: 'AppsSubmitEditView',
  },
};

/**
 * Components a page may render as a SIBLING of the chrome because they are portaled
 * overlays — they leave the container's layout flow entirely, so "outside the measure
 * box" is where they belong rather than a defect.
 *
 * 🔴 VERIFIED, NOT TRUSTED — the same rule as {@link CHROME_DELEGATES}, and for the same
 * reason: an allowlist keyed on a NAME is exactly where real page content would hide, and
 * "…Modal" is a naming convention, not a guarantee. The test below parses each entry and
 * fails unless it actually renders a portaling overlay at its top level. Adding a name
 * here cannot silence the guard.
 */
const CHROME_PORTAL_SIBLINGS: Record<string, { file: string; exportName: string }> = {
  OnsiteReviewModal: {
    file: 'src/components/Apps/OnsiteReviewModal.tsx',
    exportName: 'OnsiteReviewModal',
  },
  OffsiteReviewModal: {
    file: 'src/components/Apps/OffsiteReviewQueue.tsx',
    exportName: 'OffsiteReviewModal',
  },
  CombinedReviewModal: {
    file: 'src/components/Apps/CombinedReviewModal.tsx',
    exportName: 'CombinedReviewModal',
  },
};

/** Tags that mean "a portaled overlay root" when a portal sibling renders one. */
const PORTAL_ROOT_TAGS = new Set(['Modal', 'Modal.Stack', 'Drawer', 'Drawer.Stack', 'Portal']);

/** Tag names that mean "a fragment", i.e. unwrap the children rather than count the tag. */
const FRAGMENT_TAGS = new Set(['React.Fragment', 'Fragment']);

/**
 * EVERY top-level renderable JSX tag a component can render, one array per `return`.
 *
 * 🔴 AN AST WALK BECAUSE A TEXT GUARD IS WALKABLE BY A COMMENT. `/<AppsPageLayout[\s>]/`
 * over the file's source matches a commented-out element just as happily as a real render,
 * so a page could be re-orphaned while the guard stayed green. Comments are TRIVIA in the
 * TypeScript AST — not nodes — so a commented-out element simply is not here.
 *
 * 🔴 EVERY BRANCH IS COLLECTED, AND THAT IS LOAD-BEARING GIVEN HOW THE RESULT IS USED.
 * A ternary contributes BOTH arms, a fragment contributes ALL its children, and a
 * `&&` contributes its JSX side. That is only safe because {@link chromeOffenders}
 * requires EVERY tag to be allowed rather than asking whether the layout appears
 * SOMEWHERE. An earlier version paired this same flattening with an `includes` check, so
 * one good ternary arm covered for a re-orphaned one — the union hid the violation
 * instead of exposing it. Union + "all must be allowed" is the combination that works;
 * union + "any may match" is strictly worse than not flattening at all.
 *
 * Nested functions are deliberately NOT descended into: a `.map()` callback or a locally
 * declared sub-component has its own returns, and they are not the page's outermost render.
 */
function pageReturnTags(file: string, exportName?: string): string[][] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  );

  // 🔴 THREE DEFAULT-EXPORT SHAPES, because rejecting a legitimate one turns the BLOCKING
  // suite red on a page that is perfectly correct: `export default function P() {}`,
  // `const P = () => {}; export default P;`, and `export default () => {}`. A guard that
  // only understands one spelling is a guard against a spelling, not against the hazard.
  let body: ts.Node | undefined;
  const defaultExportedNames = new Set<string>();
  source.forEachChild((node) => {
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      if (ts.isIdentifier(node.expression))
        defaultExportedNames.add(node.expression.getText(source));
      // `export default () => …` / `export default function () {}`
      else if (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)) {
        if (!exportName) body = node.expression.body;
      }
    }
  });
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText(source);
      const matches = exportName
        ? name === exportName
        : node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ||
          (name != null && defaultExportedNames.has(name));
      if (matches && node.body) body = node.body;
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText(source);
        const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        const matches = exportName
          ? name === exportName && isExported
          : defaultExportedNames.has(name);
        if (!matches || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          body = decl.initializer.body;
        }
      }
    }
  });
  if (!body) {
    throw new Error(
      exportName
        ? `no exported component \`${exportName}\` found`
        : 'no default-exported component found (tried: export default function, ' +
          'const X = () => …; export default X, export default () => …)'
    );
  }

  /** Tag names at the TOP level of one returned expression. */
  const topLevelTags = (expr: ts.Expression | undefined): string[] => {
    if (!expr) return [];
    if (ts.isParenthesizedExpression(expr)) return topLevelTags(expr.expression);
    // Both arms — see the 🔴 note above on why the union is safe here.
    if (ts.isConditionalExpression(expr))
      return [...topLevelTags(expr.whenTrue), ...topLevelTags(expr.whenFalse)];
    // `cond && <A/>` / `a ?? <B/>` — either side may be the JSX.
    if (ts.isBinaryExpression(expr))
      return [...topLevelTags(expr.left), ...topLevelTags(expr.right)];
    const childTags = (children: ts.NodeArray<ts.JsxChild>): string[] => {
      const tags: string[] = [];
      for (const child of children) {
        if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
          tags.push(...topLevelTags(child as unknown as ts.Expression));
        } else if (ts.isJsxExpression(child)) tags.push(...topLevelTags(child.expression));
      }
      return tags;
    };
    if (ts.isJsxElement(expr)) {
      const tag = expr.openingElement.tagName.getText(source);
      // `<React.Fragment>` is a fragment written the long way — unwrap it, or a perfectly
      // correct page reads as rendering an unknown element called `React.Fragment`.
      return FRAGMENT_TAGS.has(tag) ? childTags(expr.children) : [tag];
    }
    if (ts.isJsxSelfClosingElement(expr)) {
      const tag = expr.tagName.getText(source);
      return FRAGMENT_TAGS.has(tag) ? [] : [tag];
    }
    if (ts.isJsxFragment(expr)) return childTags(expr.children);
    return [];
  };

  const groups: string[][] = [];
  const visit = (node: ts.Node) => {
    // Do not descend into a nested function — its returns are not the page's render.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node)) {
      groups.push(topLevelTags(node.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  // A concise arrow body (`() => <X/>`) is an expression, not a block: it IS the return.
  if (ts.isBlock(body as ts.Node)) ts.forEachChild(body as ts.Node, visit);
  else groups.push(topLevelTags(body as ts.Expression));
  return groups;
}

/**
 * The ONE rule, applied to pages and to chrome delegates alike: in every return that
 * renders anything, EVERY top-level tag must be the shared layout, a verified delegate,
 * or an exempt leaf.
 *
 * 🔴 "EVERY", NOT "CONTAINS ONE". The predicate used to be
 * `rendered.includes('AppsPageLayout')`, which three different shapes walked straight
 * past because they put an un-chromed element ALONGSIDE a chromed one: a ternary whose
 * other arm rendered a bare centred `<Box>`, a fragment child ternary of the same shape,
 * and a plain un-chromed sibling inside the top-level fragment. In all three the layout
 * WAS present somewhere in the group, so `includes` was satisfied while real page content
 * rendered outside the chrome entirely.
 */
function chromeOffenders(label: string, groups: string[][]): string[] {
  const allowed = new Set([
    'AppsPageLayout',
    ...Object.keys(CHROME_DELEGATES),
    ...Object.keys(CHROME_PORTAL_SIBLINGS),
  ]);
  const offenders: string[] = [];
  for (const tags of groups) {
    const rendered = tags.filter((t) => !CHROME_EXEMPT_TAGS.has(t));
    if (rendered.length === 0) continue;
    const stray = rendered.filter((t) => !allowed.has(t));
    if (stray.length > 0) {
      offenders.push(
        `${label} (a return renders [${rendered.join(', ')}] outside the shared chrome — ` +
          `stray: ${stray.join(', ')})`
      );
    }
  }
  return offenders;
}

describe('the container is uniform, and it is the only container', () => {
  test('every `/apps/*` route renders in ONE container width (1920)', () => {
    // A literal, not derived from the module's own arithmetic.
    expect(APPS_PAGE_CONTAINER_WIDTH).toBe(1920);
  });

  test('🔴 there is no per-route CONTAINER width map any more', () => {
    // The defect was `APPS_PAGE_WIDTHS`: a container width per route. If it comes
    // back — under any name — the sub-nav starts moving again. `APPS_PAGE_MEASURES`
    // is a different thing (a BODY cap), and the layout guards in
    // `appsPageLayout.test.ts` pin that it can never reach the Container.
    // A NAMESPACE import, not `require`: the `~` alias is a Vite resolver and does
    // not exist for node's CJS loader, so `require` throws MODULE_NOT_FOUND and the
    // test fails for a reason that has nothing to do with the claim.
    expect(widthsModule).not.toHaveProperty('APPS_PAGE_WIDTHS');
    expect(widthsModule).not.toHaveProperty('APPS_WIDE_PAGE_WIDTH');
    expect(widthsModule).not.toHaveProperty('APPS_READABLE_PAGE_WIDTH');
    // Guard-the-guard: an empty namespace would satisfy every `not.toHaveProperty`.
    expect(widthsModule).toHaveProperty('APPS_PAGE_CONTAINER_WIDTH');
    expect(widthsModule).toHaveProperty('APPS_PAGE_MEASURES');
  });
});

describe('APPS_PAGE_MEASURES — the decided CONTENT measure per route', () => {
  test('the narrow-table measure is 1368 and only /apps/review takes it', () => {
    expect(APPS_NARROW_TABLE_MEASURE).toBe(1368);
    expect(APPS_PAGE_MEASURES['/apps/review']).toBe(1368);
    const takers = Object.entries(APPS_PAGE_MEASURES)
      .filter(([, m]) => m === APPS_NARROW_TABLE_MEASURE)
      .map(([r]) => r);
    expect(takers).toEqual(['/apps/review']);
  });

  test('the two-column detail measure is 1288 and only the store preview takes it', () => {
    expect(APPS_TWO_COLUMN_DETAIL_MEASURE).toBe(1288);
    expect(APPS_PAGE_MEASURES['/apps/store-preview/[slug]']).toBe(1288);
    // 🔴 Pinned in BOTH directions so a later "tidy-up" that folds the detail into
    // another class fails here rather than silently squeezing the right rail
    // (readable) or putting the markdown description on a ~1250px measure (full).
    expect(APPS_PAGE_MEASURES['/apps/store-preview/[slug]']).not.toBe(APPS_READABLE_MEASURE);
    expect(APPS_PAGE_MEASURES['/apps/store-preview/[slug]']).not.toBe(APPS_PAGE_CONTAINER_WIDTH);
  });

  test('the readable measure is 1068, and these six form/prose routes take it', () => {
    expect(APPS_READABLE_MEASURE).toBe(1068);
    const takers = Object.entries(APPS_PAGE_MEASURES)
      .filter(([, m]) => m === APPS_READABLE_MEASURE)
      .map(([r]) => r)
      .sort();
    // The SET, not a spot-check: this fails when a route joins or leaves.
    expect(takers).toEqual([
      '/apps/[appBlockId]/edit',
      '/apps/[appBlockId]/revenue',
      '/apps/get-started',
      '/apps/invites',
      '/apps/listing/[appListingId]/edit',
      '/apps/submit',
    ]);
  });

  test('every measure is one of the THREE decided values — no fourth hand-picked number', () => {
    // The whole point of the module is that there are a few CLASSES of apps page,
    // not eleven bespoke numbers. A new page must join a class, or the class list
    // must grow deliberately — failing here first.
    for (const [route, measure] of Object.entries(APPS_PAGE_MEASURES)) {
      expect(
        [APPS_NARROW_TABLE_MEASURE, APPS_TWO_COLUMN_DETAIL_MEASURE, APPS_READABLE_MEASURE],
        `${route}`
      ).toContain(measure);
    }
    // Pin the class list itself, as literals. Without this the check above is
    // satisfied by ANY set of constants, including a fourth one added silently.
    expect([
      APPS_NARROW_TABLE_MEASURE,
      APPS_TWO_COLUMN_DETAIL_MEASURE,
      APPS_READABLE_MEASURE,
    ]).toEqual([1368, 1288, 1068]);
  });

  test('🔴 a measure is always strictly inside the container', () => {
    // A measure ≥ the container is a no-op that reads as a decision. A measure
    // larger than the container's usable width is worse: it silently does nothing
    // while claiming a class.
    const usable = APPS_PAGE_CONTAINER_WIDTH - APPS_CONTAINER_GUTTER;
    for (const [route, measure] of Object.entries(APPS_PAGE_MEASURES)) {
      expect(measure, `${route} must actually narrow the body`).toBeLessThan(usable);
      expect(measure, `${route} must be a positive px value`).toBeGreaterThan(0);
    }
  });
});

describe('🔴 the measures preserve the OLD rendered content widths exactly', () => {
  /**
   * THE +32px TRAP, PINNED. Mantine's `Container` is border-box: `size={N}` renders
   * `N − 2×16` of content. A `maw={N}` box lives INSIDE that gutter and renders `N`.
   * So carrying the old round container numbers over as measures would have widened
   * every narrowed page by 32px — a confounded change hiding inside an alignment fix.
   *
   * Each measure is therefore the OLD container width minus the gutter, and the old
   * numbers are named here as literals so the provenance is checkable rather than
   * asserted in prose.
   */
  test('the Container gutter is 16px per side', () => {
    expect(APPS_CONTAINER_GUTTER).toBe(32);
  });

  test.each([
    ['narrow table', APPS_NARROW_TABLE_MEASURE, 1400],
    ['two-column detail', APPS_TWO_COLUMN_DETAIL_MEASURE, 1320],
    ['readable', APPS_READABLE_MEASURE, 1100],
  ])('%s: measure = old container width − gutter', (_label, measure, oldContainerWidth) => {
    expect(measure).toBe(oldContainerWidth - APPS_CONTAINER_GUTTER);
  });

  test('the two-column measure equals the MODEL DETAIL page content width', () => {
    // Its documented justification is "the same width as the model detail page",
    // which renders `<Container size="xl">` — Mantine's `xl` is 1320 border-box, so
    // its CONTENT is 1288. Stating the claim in content terms is what makes it true.
    const MANTINE_XL_CONTAINER = 1320;
    expect(APPS_TWO_COLUMN_DETAIL_MEASURE).toBe(MANTINE_XL_CONTAINER - APPS_CONTAINER_GUTTER);
  });
});

describe('🔴 the store width and the store grid span are a MATCHED PAIR', () => {
  test('LISTING_STORE_CONTAINER_SIZE reads the shared container width (one number, not two)', () => {
    // `appListingGrid.ts` used to carry its own literal 1600. If it drifts back to a
    // literal, this fails the moment the two disagree.
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(APPS_PAGE_CONTAINER_WIDTH);
    expect(LISTING_STORE_CONTAINER_SIZE).toBe(1920);
  });

  test('🔴 /apps takes NO body measure, so its content width IS the container width', () => {
    // This is what keeps the card arithmetic below true after the container/measure
    // split. Give `/apps` a measure and the grid silently re-truncates.
    expect(APPS_PAGE_MEASURES).not.toHaveProperty('/apps');
    expect(APPS_FULL_MEASURE_PAGES).toContain('/apps');
  });

  test('the container yields the card width the xl span was tuned for', () => {
    //   container 1920 − 2×16 Container padding = 1888 usable
    //   xl span 3/12 → 4 columns; Grid gutter "md" (16) → 3 gutters between them
    //   → (1888 − 3×16) / 4 = 460 px per card.
    const GUTTER = 16;
    const columns = 12 / LISTING_GRID_SPAN.xl;
    const usable = LISTING_STORE_CONTAINER_SIZE - APPS_CONTAINER_GUTTER;
    const cardWidth = (usable - GUTTER * (columns - 1)) / columns;
    expect(columns).toBe(4);
    expect(cardWidth).toBe(460);
  });
});

describe('🔴 /apps/mine is wide enough for its table, as a RELATIONSHIP', () => {
  /**
   * This replaces the deleted `MY_APPS_CONTAINER_SIZE` alias and its `> 1100` pin.
   * The alias could not have noticed the container dropping to 1400; the relationship
   * can, because it names the floor the table actually has.
   */
  test('the container clears the submissions-table scroll floor', () => {
    const contentWidth = APPS_PAGE_CONTAINER_WIDTH - SUBMISSIONS_CONTAINER_CHROME;
    expect(contentWidth).toBeGreaterThan(SUBMISSIONS_TABLE_MIN_WIDTH);
  });

  test('…and it does so because /apps/mine takes no measure', () => {
    // If it ever took the readable measure, the floor would NOT be cleared — which
    // is exactly the clip the wide width was introduced to fix. Asserted as the
    // counterfactual so the previous test cannot pass for the wrong reason.
    expect(APPS_PAGE_MEASURES).not.toHaveProperty('/apps/mine');
    expect(APPS_FULL_MEASURE_PAGES).toContain('/apps/mine');
    expect(APPS_READABLE_MEASURE - SUBMISSIONS_CONTAINER_CHROME).toBeLessThan(
      SUBMISSIONS_TABLE_MIN_WIDTH
    );
  });
});

describe('the route taxonomy', () => {
  test('a route is classified exactly once (no overlap between the four lists)', () => {
    const all = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  test('the RETIRED /apps/[appBlockId] is redirect-only, not a measure', () => {
    // It was once listed as a rendering route with the comment "still renders for a
    // direct hit". The page's own docstring says RETIRED and its
    // `getServerSideProps` unconditionally redirects, so a width there was
    // unreachable AND made the module assert a false fact about the app.
    expect(APPS_PAGE_MEASURES).not.toHaveProperty('/apps/[appBlockId]');
    expect(APPS_REDIRECT_ONLY_PAGES).toContain('/apps/[appBlockId]');
  });

  test('the merged-away /apps/my-submissions is not listed anywhere', () => {
    const all = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ];
    expect(all).not.toContain('/apps/my-submissions');
  });
});

/**
 * 🔴 THE ENUMERATION GUARD — the reason this file reads the filesystem.
 *
 * A constants map is only "every apps page" if something checks it against the pages
 * that actually exist. Without this, a new `/apps/*` route silently renders its own
 * bare `<Container>` and the uniform-chrome decision quietly stops being true —
 * exactly the drift that left FOUR pages (`get-started`, `[appBlockId]/edit`,
 * `[appBlockId]/revenue`, `listing/[appListingId]/edit`) with no sub-nav at all.
 */
describe('every /apps page on disk is classified', () => {
  const PAGES_DIR = path.resolve(__dirname, '../../../pages/apps');

  /** Walk `src/pages/apps` and return each page's Next route pathname. */
  function appsRoutes(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, `${prefix}/${entry.name}`);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        const base = entry.name.replace(/\.tsx?$/, '');
        out.push(base === 'index' ? prefix : `${prefix}/${base}`);
      }
    };
    walk(PAGES_DIR, '/apps');
    return out.sort();
  }

  /** Absolute path of the page file backing a route pathname. */
  function pageFile(route: string): string {
    const rel = route === '/apps' ? '/apps/index' : route;
    return path.resolve(PAGES_DIR, '..', `${rel.replace(/^\/apps\//, 'apps/')}.tsx`);
  }

  test('the walker actually found the apps pages (guards a silently-empty scan)', () => {
    // A test that classifies zero routes would pass vacuously — the failure mode
    // that makes an fs-backed guard worthless. Pin a floor AND known members from
    // every list, so a walk that finds only the shallow files still fails.
    const routes = appsRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(20);
    expect(routes).toContain('/apps');
    expect(routes).toContain('/apps/review');
    expect(routes).toContain('/apps/get-started');
    expect(routes).toContain('/apps/[appBlockId]/edit');
    expect(routes).toContain('/apps/listing/[appListingId]/edit');
    expect(routes).toContain('/apps/run/[slug]/[[...path]]');
  });

  test('no /apps route is unclassified', () => {
    const classified = new Set<string>([
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ]);
    const unclassified = appsRoutes().filter((r) => !classified.has(r));
    expect(
      unclassified,
      `Unclassified /apps route(s). Add each to APPS_PAGE_MEASURES (a narrower body), ` +
        `APPS_FULL_MEASURE_PAGES (full container), APPS_FULL_BLEED_PAGES (full-viewport ` +
        `iframe/shell) or APPS_REDIRECT_ONLY_PAGES (getServerSideProps always ` +
        `redirects/404s) in src/components/Apps/appsPageWidths.ts.`
    ).toEqual([]);
  });

  /**
   * 🔴 CONSUMPTION — the cheap half of "is this entry real?".
   *
   * The completeness walk only proves a route is LISTED. It cannot notice that a
   * listed route's measure is never read, which is exactly how `/apps/[appBlockId]`
   * came to carry a `Container size=` its always-redirecting `getServerSideProps`
   * made unreachable.
   *
   * There are no ALIAS consumers left. Both former ones —
   * `LISTING_STORE_CONTAINER_SIZE` for `/apps` and `MY_APPS_CONTAINER_SIZE` for
   * `/apps/mine` — existed to hand a per-page CONTAINER width to the layout; both
   * routes are now measure-free, so every entry below is read directly and the
   * special-casing is gone. (The old ALIASES map also carried real doc-rot: it named
   * `MY_SUBMISSIONS_CONTAINER_SIZE`, a constant that had been renamed.)
   *
   * ⚠️ WHAT THIS STILL CANNOT CATCH: a route that is listed, consumes its measure,
   * and yet never renders because something upstream always redirects. That remains
   * a judgement made by reading the page — see the module docstring.
   */
  test('every APPS_PAGE_MEASURES entry is actually consumed by its page', () => {
    const unconsumed: string[] = [];
    for (const route of Object.keys(APPS_PAGE_MEASURES)) {
      const file = pageFile(route);
      if (!fs.existsSync(file)) {
        unconsumed.push(`${route} (no page file at ${file})`);
        continue;
      }
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes(`APPS_PAGE_MEASURES['${route}']`)) {
        unconsumed.push(`${route} (expected APPS_PAGE_MEASURES['${route}'])`);
      }
    }
    expect(
      unconsumed,
      'Listed route(s) whose page never reads the measure — either wire the page up ' +
        'or move the route to APPS_FULL_MEASURE_PAGES / APPS_FULL_BLEED_PAGES / ' +
        'APPS_REDIRECT_ONLY_PAGES.'
    ).toEqual([]);
  });

  /**
   * 🔴 LAYOUT ADOPTION — the guard that catches the FOUR orphans, and any new page.
   *
   * Completeness and consumption between them still allowed a page to render its own
   * bare `<Container>` with no sub-nav: `/apps/get-started`, `/apps/[appBlockId]/edit`,
   * `/apps/[appBlockId]/revenue` and `/apps/listing/[appListingId]/edit` all did, and
   * every guard in this file passed. Uniform chrome is a claim about EVERY rendering
   * route, so it is checked against every rendering route.
   */
  describe('🔴 every rendering /apps page renders the shared chrome', () => {
    /** Routes expected to mount `AppsPageLayout`: measured + full-measure. */
    const RENDERING_ROUTES = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
    ].sort();

    test('the rendering set is the one we think it is (fails if it grows OR shrinks)', () => {
      // A ledger, not a floor: a loop over a set nobody pinned passes vacuously when
      // the set empties, and silently skips a page when the set shrinks.
      expect(RENDERING_ROUTES).toEqual([
        '/apps',
        '/apps/[appBlockId]/edit',
        '/apps/[appBlockId]/revenue',
        '/apps/get-started',
        '/apps/installed',
        '/apps/invites',
        '/apps/listing/[appListingId]/edit',
        '/apps/mine',
        // 🔴 'revenue' sorts BEFORE 'review' — they diverge at index 9, 'e' < 'i'.
        '/apps/revenue',
        '/apps/review',
        '/apps/review/[publishRequestId]',
        '/apps/store-preview/[slug]',
        '/apps/submit',
      ]);
      expect(RENDERING_ROUTES).toHaveLength(13);
    });

    test('every RETURN of every page renders the layout (AST, not text)', () => {
      // 🔴 PARSED, NOT GREPPED, and that is the whole point — see `pageReturnTags`.
      // A text guard here was walkable two ways at once: move `<AppsPageLayout …>` into
      // a JSX comment (the regex matches the COMMENT) and render `<Box maw={…}
      // mx="auto">` instead (no `<Container>`, so the sibling ban never fires). The page
      // is re-orphaned with no sub-nav and both text guards stay green.
      const offenders: string[] = [];
      let filesParsed = 0;
      let returnsInspected = 0;
      for (const route of RENDERING_ROUTES) {
        const file = pageFile(route);
        if (!fs.existsSync(file)) {
          offenders.push(`${route} (no page file at ${file})`);
          continue;
        }
        let groups: string[][];
        try {
          groups = pageReturnTags(file);
        } catch (err) {
          offenders.push(`${route} (could not parse: ${(err as Error).message})`);
          continue;
        }
        filesParsed += 1;
        if (groups.length === 0) {
          offenders.push(`${route} (default export has no return statement)`);
          continue;
        }
        returnsInspected += groups.length;
        // ONE rule, shared with the delegate check below — see `chromeOffenders`.
        offenders.push(...chromeOffenders(route, groups));
      }
      // 🔴 THE OFFENDER LIST IS ASSERTED FIRST, DELIBERATELY. When a page uses a shape the
      // walk cannot parse, `filesParsed` also comes up short — and if the count assertion
      // ran first it would fail with "expected 12 to be 13", burying the one message that
      // says WHICH page and WHY. Vitest stops at the first failing expect, so the
      // informative assertion has to be the first one.
      expect(
        offenders,
        'Rendering /apps route(s) not on the shared chrome. Wrap the page body in ' +
          '<AppsPageLayout> (passing `measure` only if it is in APPS_PAGE_MEASURES) ' +
          'instead of any container of its own.'
      ).toEqual([]);
      // Guard-the-guard, twice: an empty `offenders` is indistinguishable from a loop
      // that parsed nothing, AND from one that parsed files but found no returns.
      expect(filesParsed, 'the AST walk parsed no page files').toBe(RENDERING_ROUTES.length);
      expect(returnsInspected, 'the AST walk found no returns to inspect').toBeGreaterThanOrEqual(
        RENDERING_ROUTES.length
      );
    });

    test('🔴 every chrome DELEGATE really does mount the chrome', () => {
      // The allowlist is the one place a genuine orphan could hide behind a reassuring
      // name, so the delegate is held to LITERALLY the same rule as a page — the same
      // `chromeOffenders` function, not a paraphrase of it.
      //
      // 🔴 IT USED TO BE `groups.some(tags => tags.includes('AppsPageLayout'))` while this
      // test's own description said "every return that renders anything". Giving
      // `AppsSubmitEditView` an early return rendering a bare centred `<Box>` walked
      // straight past it: one good return vouched for a bad one, in the very check whose
      // job is to stop the allowlist being taken on trust.
      const names = Object.keys(CHROME_DELEGATES);
      expect(names.length, 'the delegate list is empty — nothing to verify').toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const name of names) {
        const { file, exportName } = CHROME_DELEGATES[name];
        const abs = path.resolve(__dirname, '../../../..', file);
        if (!fs.existsSync(abs)) {
          offenders.push(`${name} (no file at ${abs})`);
          continue;
        }
        const groups = pageReturnTags(abs, exportName);
        if (groups.length === 0) {
          offenders.push(`${name} (has no return statement)`);
          continue;
        }
        const renders = groups.some((tags) => tags.includes('AppsPageLayout'));
        if (!renders) offenders.push(`${name} (does not render AppsPageLayout)`);
        offenders.push(...chromeOffenders(name, groups));
      }
      expect(
        offenders,
        'A component allowlisted as mounting the shared chrome does not actually mount it.'
      ).toEqual([]);
    });

    /**
     * 🔴 THE RULE ITSELF, TABLE-DRIVEN — because every other test here consumes
     * `chromeOffenders` and none of them PINS it.
     *
     * Found by mutating the guard rather than the code: weakening `chromeOffenders` back
     * to its old "does the layout appear anywhere in this group" semantics, together with
     * a real un-chromed sibling on a page, passed the entire blocking suite. The AST
     * negative control below could not see it — it exercises `pageReturnTags` and
     * inspects the tags itself, never routing through the rule. So the rule was the one
     * piece of this machinery with no guard of its own.
     *
     * The `[AppsPageLayout, Box]` rows are the load-bearing ones: they are exactly the
     * shapes an `includes`-style predicate waves through, because the layout IS present —
     * alongside page content rendering outside it.
     */
    describe('🔴 chromeOffenders — the rule, pinned directly', () => {
      const cases: { name: string; group: string[]; offends: boolean }[] = [
        { name: 'the layout alone', group: ['AppsPageLayout'], offends: false },
        { name: 'Meta beside the layout', group: ['Meta', 'AppsPageLayout'], offends: false },
        { name: 'a bare access-denied leaf', group: ['NotFound'], offends: false },
        { name: 'nothing renderable', group: [], offends: false },
        { name: 'a verified delegate', group: ['AppsSubmitEditView'], offends: false },
        {
          name: 'a portaled overlay beside the layout',
          group: ['AppsPageLayout', 'OnsiteReviewModal'],
          offends: false,
        },
        { name: 'page content with NO layout', group: ['Box'], offends: true },
        // 🔴 The two an `includes` check passes.
        {
          name: 'an un-chromed SIBLING alongside the layout',
          group: ['AppsPageLayout', 'Box'],
          offends: true,
        },
        {
          name: 'a ternary whose other arm is un-chromed (flattened to one group)',
          group: ['AppsPageLayout', 'Container'],
          offends: true,
        },
      ];

      test.each(cases)('$name', ({ group, offends }) => {
        const out = chromeOffenders('fixture', [group]);
        expect(out.length > 0).toBe(offends);
      });

      test('the offender message names the stray tag, not just the route', () => {
        // A guard whose message does not say WHAT is wrong sends the next reader hunting.
        const [msg] = chromeOffenders('/apps/x', [['AppsPageLayout', 'Box']]);
        expect(msg).toContain('/apps/x');
        expect(msg).toContain('stray: Box');
      });

      test('every case fixture is distinct (no row silently duplicates another)', () => {
        // Guard-the-guard: duplicated rows inflate the table without adding coverage.
        const keys = cases.map((c) => c.group.join('|'));
        expect(new Set(keys).size).toBe(keys.length);
        // …and the table exercises BOTH verdicts, so it cannot pass by always agreeing.
        expect(cases.some((c) => c.offends)).toBe(true);
        expect(cases.some((c) => !c.offends)).toBe(true);
      });
    });

    test('🔴 every PORTAL SIBLING really is a portaled overlay', () => {
      // Same contract as the delegate check: the exemption is earned by what the
      // component renders, not by what it is called. A page-content component wrongly
      // listed here would be waved past the chrome rule, which is the whole hazard an
      // allowlist introduces.
      const names = Object.keys(CHROME_PORTAL_SIBLINGS);
      expect(names.length, 'the portal-sibling list is empty — nothing to verify').toBeGreaterThan(
        0
      );
      const offenders: string[] = [];
      for (const name of names) {
        const { file, exportName } = CHROME_PORTAL_SIBLINGS[name];
        const abs = path.resolve(__dirname, '../../../..', file);
        if (!fs.existsSync(abs)) {
          offenders.push(`${name} (no file at ${abs})`);
          continue;
        }
        const groups = pageReturnTags(abs, exportName);
        if (groups.length === 0) {
          offenders.push(`${name} (has no return statement)`);
          continue;
        }
        // Every return that renders anything must render a portal root — an early
        // return of ordinary markup would put real content outside the chrome.
        for (const tags of groups) {
          const rendered = tags.filter((t) => !CHROME_EXEMPT_TAGS.has(t));
          if (rendered.length === 0) continue;
          const stray = rendered.filter((t) => !PORTAL_ROOT_TAGS.has(t));
          if (stray.length > 0) {
            offenders.push(`${name} (a return renders non-portal roots: ${stray.join(', ')})`);
          }
        }
      }
      expect(
        offenders,
        'A component allowlisted as a portaled overlay renders ordinary markup instead — ' +
          'it would place page content outside the shared chrome.'
      ).toEqual([]);
    });

    test('🔴 the AST walk can SEE a violation (negative control on the guard above)', () => {
      // The guard above returns a reassuring empty list; this proves the machinery that
      // produces it can produce a non-empty one. A synthetic page whose layout call sits
      // in a comment — mutant M5b exactly — must be reported, and the comment must NOT
      // count as a render.
      const tmp = path.join(os.tmpdir(), `apps-chrome-negative-control-${process.pid}.tsx`);
      fs.writeFileSync(
        tmp,
        [
          "import { Box } from '@mantine/core';",
          "import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';",
          'export default function FakePage() {',
          '  return (',
          '    <>',
          '      {/* <AppsPageLayout measure={1068}> */}',
          '      <Box maw={1068} mx="auto" />',
          '      {/* </AppsPageLayout> */}',
          '    </>',
          '  );',
          '}',
        ].join('\n')
      );
      try {
        const groups = pageReturnTags(tmp);
        expect(groups).toHaveLength(1);
        const rendered = groups[0].filter((t) => !CHROME_EXEMPT_TAGS.has(t));
        // The comment is trivia in the AST, so it cannot masquerade as a render.
        expect(rendered).not.toContain('AppsPageLayout');
        expect(rendered).toContain('Box');
      } finally {
        fs.unlinkSync(tmp);
      }
    });

    test('🔴 no rendering page hand-rolls its own top-level Mantine Container', () => {
      // The specific shape of the defect: a page-level `<Container>` re-creates the
      // per-page box the layout exists to remove. Nested containers inside a body
      // component are not this file's business — this checks the PAGE files, which
      // are the ones that own the outermost element.
      const offenders: string[] = [];
      let filesRead = 0;
      for (const route of RENDERING_ROUTES) {
        const file = pageFile(route);
        if (!fs.existsSync(file)) continue;
        const src = fs.readFileSync(file, 'utf8');
        filesRead += 1;
        if (/<Container[\s>]/.test(src)) offenders.push(`${route} (renders its own <Container>)`);
      }
      expect(filesRead).toBe(RENDERING_ROUTES.length);
      expect(offenders).toEqual([]);
    });
  });

  test('no classified route is stale (every entry maps to a real page file)', () => {
    const onDisk = new Set(appsRoutes());
    const stale = [
      ...Object.keys(APPS_PAGE_MEASURES),
      ...APPS_FULL_MEASURE_PAGES,
      ...APPS_FULL_BLEED_PAGES,
      ...APPS_REDIRECT_ONLY_PAGES,
    ].filter((r) => !onDisk.has(r));
    expect(stale, 'Classified route(s) with no page file — delete the entry.').toEqual([]);
  });
});
