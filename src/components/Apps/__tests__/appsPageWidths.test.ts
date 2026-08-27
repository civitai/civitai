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

/** Tags that mean "a portaled overlay root" — checked together with their IMPORT source. */
const PORTAL_ROOT_TAGS = new Set(['Modal', 'Modal.Stack', 'Drawer', 'Drawer.Stack', 'Portal']);

/** The package a portal root must come from for the name to mean anything. */
const PORTAL_ROOT_MODULE = '@mantine/core';

/**
 * The module specifier a top-level identifier was imported from, or `null`.
 *
 * 🔴 THIS IS WHAT STOPS THE PORTAL CONTRACT BEING A NAME CHECK. Matching the tag `Modal`
 * against a set of strings trusts whatever the file chose to call things: a component
 * defining its own `const Modal = ({children}) => <Box mx="auto">{children}</Box>` and
 * returning `<Modal>` satisfied a name-only test completely, and was then allowlisted as
 * a "portaled overlay" — moving the trust from the component's name to the name of the
 * tag it happens to render, which is no improvement at all. Resolving the import is the
 * difference between "it is called Modal" and "it IS Mantine's Modal".
 */
function importSourceOf(source: ts.SourceFile, baseName: string): string | null {
  let found: string | null = null;
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause) return;
    const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
    const { name, namedBindings } = node.importClause;
    if (name?.getText(source) === baseName) found = specifier;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const el of namedBindings.elements) {
        if (el.name.getText(source) === baseName) found = specifier;
      }
    } else if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      if (namedBindings.name.getText(source) === baseName) found = specifier;
    }
  });
  return found;
}

/** Parse `file` once so a caller can resolve imports in it. */
function sourceFileOf(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

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
        // 🔴 A NESTED ANONYMOUS FRAGMENT. `<><Box/></>` sitting inside another fragment
        // used to be dropped on the floor here: `JsxFragment` is neither a `JsxElement`
        // nor a `JsxExpression`, so the loop skipped it and its children were never
        // inspected. `<React.Fragment>` WAS handled, so the two spellings of the same
        // thing disagreed — and the docstring claimed "a fragment contributes ALL its
        // children" for both.
        else if (ts.isJsxFragment(child)) tags.push(...childTags(child.children));
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
    // `{[<Box key="a" />]}` — a list of elements renders every entry.
    if (ts.isArrayLiteralExpression(expr)) return expr.elements.flatMap((el) => topLevelTags(el));
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
 * The ONE rule, applied to pages and to chrome delegates alike. In EVERY return that
 * renders anything: every top-level tag must be permitted there, AND the chrome must
 * actually be mounted.
 *
 * 🔴 TWO CLAUSES, BECAUSE EACH ALONE HAS A HOLE THE OTHER CLOSES.
 *
 * "No stray tag" replaced an older `rendered.includes('AppsPageLayout')`, which three
 * shapes walked past by putting un-chromed content ALONGSIDE chromed content — a ternary
 * whose other arm rendered a bare centred `<Box>`, the same as a fragment child, and a
 * plain un-chromed sibling. The layout WAS present, so `includes` was satisfied while
 * real page content rendered outside it.
 *
 * But "no stray tag" alone is satisfied by a group containing NO chrome provider at all,
 * because portal siblings are permitted tags: `chromeOffenders('x', [['OnsiteReviewModal']])`
 * returned `[]`, i.e. a page whose only top-level render is an overlay passed with no
 * chrome. Permission to appear beside the chrome is not the same as providing it, and
 * conflating the two is what let the allowlist stand in for the layout.
 *
 * 🔴 EVERY GROUP IS EVALUATED — `continue`, never `break`. A page's FIRST return is
 * routinely a gate (`return <NotFound />`), which filters to empty; a `break` there would
 * skip every later return and report green having inspected nothing. Pinned by the
 * multi-group rows in this file's `chromeOffenders` table.
 */
function chromeOffenders(label: string, groups: string[][]): string[] {
  /** Tags that MOUNT the chrome. */
  const providers = new Set(['AppsPageLayout', ...Object.keys(CHROME_DELEGATES)]);
  /** Tags merely PERMITTED beside it — they provide nothing on their own. */
  const permitted = new Set([...providers, ...Object.keys(CHROME_PORTAL_SIBLINGS)]);
  const offenders: string[] = [];
  for (const tags of groups) {
    const rendered = tags.filter((t) => !CHROME_EXEMPT_TAGS.has(t));
    if (rendered.length === 0) continue;
    const stray = rendered.filter((t) => !permitted.has(t));
    if (stray.length > 0) {
      offenders.push(
        `${label} (a return renders [${rendered.join(', ')}] outside the shared chrome — ` +
          `stray: ${stray.join(', ')})`
      );
      continue;
    }
    if (!rendered.some((t) => providers.has(t))) {
      offenders.push(
        `${label} (a return renders [${rendered.join(', ')}] with NO chrome provider — ` +
          `a portaled overlay may sit beside the layout, it cannot replace it)`
      );
    }
  }
  return offenders;
}

/**
 * Does the component at `file` honour the portaled-overlay contract?
 *
 * 🔴 EXTRACTED SO IT CAN BE TESTED ON A KNOWN-BAD INPUT. While this logic was inline in
 * its test, nothing exercised it except the three real entries — all of which pass — so
 * disabling the import check entirely still produced a fully green suite. A guard whose
 * only inputs are known-good cannot be shown to work; the negative control beside its
 * test now feeds it a fixture that MUST be reported.
 */
function portalOffenders(name: string, abs: string, exportName: string): string[] {
  const offenders: string[] = [];
  if (!fs.existsSync(abs)) return [`${name} (no file at ${abs})`];
  let groups: string[][];
  try {
    groups = pageReturnTags(abs, exportName);
  } catch (err) {
    return [`${name} (could not parse: ${(err as Error).message})`];
  }
  if (groups.length === 0) return [`${name} (has no return statement)`];
  const source = sourceFileOf(abs);
  // Every return that renders anything must render a portal root — an early return of
  // ordinary markup would put real content outside the chrome.
  for (const tags of groups) {
    const rendered = tags.filter((t) => !CHROME_EXEMPT_TAGS.has(t));
    if (rendered.length === 0) continue;
    const stray = rendered.filter((t) => !PORTAL_ROOT_TAGS.has(t));
    if (stray.length > 0) {
      offenders.push(`${name} (a return renders non-portal roots: ${stray.join(', ')})`);
      continue;
    }
    // 🔴 AND THE NAME MUST RESOLVE TO THE REAL COMPONENT. `Modal` is just an identifier;
    // a file is free to define its own. Without this the contract trusted a spelling, and
    // a locally-defined `const Modal = … <Box mx="auto">` satisfied it completely.
    for (const tag of rendered) {
      const base = tag.split('.')[0];
      const from = importSourceOf(source, base);
      if (from !== PORTAL_ROOT_MODULE) {
        offenders.push(
          `${name} (renders <${tag}>, but \`${base}\` is ` +
            (from ? `imported from '${from}'` : 'not imported at all') +
            ` — a portal root must come from '${PORTAL_ROOT_MODULE}')`
        );
      }
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
        // 🔴 CAUGHT, like the page loop. An allowlist entry written in a shape the walk
        // cannot parse used to THROW out of the test, so the run died with a raw stack
        // instead of the named offender assertion — the exact opposite of the message
        // ordering fixed a round ago.
        let groups: string[][];
        try {
          groups = pageReturnTags(abs, exportName);
        } catch (err) {
          offenders.push(`${name} (could not parse: ${(err as Error).message})`);
          continue;
        }
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
      // 🔴 EVERY ROW IS A LIST OF GROUPS, NOT ONE GROUP, and that is the point of the
      // shape. The table used to pass `[group]` — always exactly one — so the loop OVER
      // groups was never exercised: `groups.slice(0, 1)` and `continue`→`break` both
      // survived the whole suite, even with a real un-chromed sibling planted on
      // /apps/review. `break` is the realistic one: a page's first return is routinely a
      // gate that filters to empty, so it would skip every later return and report green
      // having inspected nothing.
      const cases: { name: string; groups: string[][]; offends: boolean }[] = [
        { name: 'the layout alone', groups: [['AppsPageLayout']], offends: false },
        { name: 'Meta beside the layout', groups: [['Meta', 'AppsPageLayout']], offends: false },
        { name: 'a bare access-denied leaf', groups: [['NotFound']], offends: false },
        { name: 'nothing renderable', groups: [[]], offends: false },
        { name: 'no returns at all', groups: [], offends: false },
        { name: 'a verified delegate', groups: [['AppsSubmitEditView']], offends: false },
        {
          name: 'a portaled overlay beside the layout',
          groups: [['AppsPageLayout', 'OnsiteReviewModal']],
          offends: false,
        },
        { name: 'page content with NO layout', groups: [['Box']], offends: true },
        // 🔴 The two an `includes` check passes.
        {
          name: 'an un-chromed SIBLING alongside the layout',
          groups: [['AppsPageLayout', 'Box']],
          offends: true,
        },
        {
          name: 'a ternary whose other arm is un-chromed (flattened to one group)',
          groups: [['AppsPageLayout', 'Container']],
          offends: true,
        },
        // 🔴 F4 — permission to sit beside the chrome is not the same as providing it.
        {
          name: 'ONLY a portaled overlay, with no chrome provider',
          groups: [['OnsiteReviewModal']],
          offends: true,
        },
        // 🔴 THE MULTI-GROUP AXIS. Each row below is green in its first group and rotten
        // in a later one, so anything that stops after the first return lets it through.
        {
          name: 'a GATE return first, then an un-chromed one (kills `break`)',
          groups: [[], ['Box']],
          offends: true,
        },
        {
          name: 'a NotFound gate first, then an un-chromed one (kills `break`)',
          groups: [['NotFound'], ['Box']],
          offends: true,
        },
        {
          name: 'a good return first, then an un-chromed one (kills slice(0, 1))',
          groups: [['AppsPageLayout'], ['Box']],
          offends: true,
        },
        {
          name: 'three returns, only the LAST rotten',
          groups: [['AppsPageLayout'], ['NotFound'], ['Container']],
          offends: true,
        },
        {
          name: 'several good returns stay clean',
          groups: [['AppsPageLayout'], ['NotFound'], ['Meta', 'AppsPageLayout']],
          offends: false,
        },
      ];

      test.each(cases)('$name', ({ groups, offends }) => {
        const out = chromeOffenders('fixture', groups);
        expect(out.length > 0).toBe(offends);
      });

      test('the offender message names the stray tag, not just the route', () => {
        // A guard whose message does not say WHAT is wrong sends the next reader hunting.
        const [msg] = chromeOffenders('/apps/x', [['AppsPageLayout', 'Box']]);
        expect(msg).toContain('/apps/x');
        expect(msg).toContain('stray: Box');
      });

      test('the NO-PROVIDER message is distinct from the stray-tag one', () => {
        // Two different defects must not print the same sentence, or the message stops
        // telling you which one you have.
        const [stray] = chromeOffenders('/apps/x', [['AppsPageLayout', 'Box']]);
        const [none] = chromeOffenders('/apps/x', [['OnsiteReviewModal']]);
        expect(none).toContain('NO chrome provider');
        expect(stray).not.toContain('NO chrome provider');
      });

      test('a later rotten return is reported even when an earlier one is fine', () => {
        // The message must name the offending group, not merely count one.
        const out = chromeOffenders('/apps/x', [['AppsPageLayout'], ['Box']]);
        expect(out).toHaveLength(1);
        expect(out[0]).toContain('stray: Box');
      });

      test('EVERY rotten group is reported, not just the first', () => {
        // Pins that the loop keeps going after it finds one — a `break` on the offending
        // branch would report 1 of 2 and still fail the suite, so only a count sees it.
        const out = chromeOffenders('/apps/x', [['Box'], ['AppsPageLayout'], ['Container']]);
        expect(out).toHaveLength(2);
      });

      test('the table exercises the multi-group axis and both verdicts', () => {
        // Guard-the-guard: duplicated rows inflate the table without adding coverage, and
        // a table of single-group rows cannot see a loop bug at all.
        const keys = cases.map((c) => JSON.stringify(c.groups));
        expect(new Set(keys).size).toBe(keys.length);
        expect(cases.some((c) => c.offends)).toBe(true);
        expect(cases.some((c) => !c.offends)).toBe(true);
        // At least two rows must carry MORE THAN ONE group, or the loop is unpinned again.
        expect(cases.filter((c) => c.groups.length > 1).length).toBeGreaterThanOrEqual(2);
        // …and at least one multi-group row must be clean ONLY in its first group, which
        // is the precise shape `break` and `slice(0, 1)` survive.
        expect(
          cases.some(
            (c) =>
              c.groups.length > 1 &&
              c.offends &&
              chromeOffenders('probe', [c.groups[0]]).length === 0
          )
        ).toBe(true);
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
      const offenders = names.flatMap((name) =>
        portalOffenders(
          name,
          path.resolve(__dirname, '../../../..', CHROME_PORTAL_SIBLINGS[name].file),
          CHROME_PORTAL_SIBLINGS[name].exportName
        )
      );
      expect(
        offenders,
        'A component allowlisted as a portaled overlay renders ordinary markup instead — ' +
          'it would place page content outside the shared chrome.'
      ).toEqual([]);
    });

    describe('🔴 the portal contract, on known-BAD inputs (negative controls)', () => {
      /**
       * Why these exist: the portal check's only real inputs are the three genuine
       * entries, and all three pass. So the check could be disabled outright — I removed
       * the import comparison and the entire suite stayed green at 135/135 — because
       * nothing ever fed it a case it had to reject. A guard tested only on known-good
       * inputs is a guard nobody has watched work.
       */
      const write = (suffix: string, body: string) => {
        const tmp = path.join(os.tmpdir(), `apps-portal-${suffix}-${process.pid}.tsx`);
        fs.writeFileSync(tmp, body);
        return tmp;
      };

      test('a LOCALLY DEFINED `Modal` is rejected, however convincingly named', () => {
        // The exact shape that survived: the tag is called Modal, so a name-only check
        // waves it through, but it is this file's own component wrapping a centred Box.
        const tmp = write(
          'local',
          [
            "import { Box } from '@mantine/core';",
            "import type { ReactNode } from 'react';",
            'const Modal = ({ children }: { children?: ReactNode }) => (',
            '  <Box maw={700} mx="auto">{children}</Box>',
            ');',
            'export function FakeOverlay() {',
            '  return <Modal>overlay</Modal>;',
            '}',
          ].join('\n')
        );
        try {
          const out = portalOffenders('FakeOverlay', tmp, 'FakeOverlay');
          expect(out).toHaveLength(1);
          expect(out[0]).toContain('not imported at all');
          expect(out[0]).toContain('@mantine/core');
        } finally {
          fs.unlinkSync(tmp);
        }
      });

      test('a `Modal` imported from the WRONG package is rejected, and the message says which', () => {
        const tmp = write(
          'wrongpkg',
          [
            "import { Modal } from 'some-other-ui-kit';",
            'export function FakeOverlay() {',
            '  return <Modal>overlay</Modal>;',
            '}',
          ].join('\n')
        );
        try {
          const out = portalOffenders('FakeOverlay', tmp, 'FakeOverlay');
          expect(out).toHaveLength(1);
          expect(out[0]).toContain("imported from 'some-other-ui-kit'");
        } finally {
          fs.unlinkSync(tmp);
        }
      });

      test('ordinary markup is rejected even before the import question', () => {
        const tmp = write(
          'plain',
          [
            "import { Box } from '@mantine/core';",
            'export function FakeOverlay() {',
            '  return <Box maw={700} mx="auto" />;',
            '}',
          ].join('\n')
        );
        try {
          const out = portalOffenders('FakeOverlay', tmp, 'FakeOverlay');
          expect(out).toHaveLength(1);
          expect(out[0]).toContain('non-portal roots: Box');
        } finally {
          fs.unlinkSync(tmp);
        }
      });

      test('POSITIVE CONTROL — a real Mantine Modal passes', () => {
        // Without this the three rejections above are satisfied by a function that
        // rejects everything.
        const tmp = write(
          'good',
          [
            "import { Modal } from '@mantine/core';",
            'export function RealOverlay() {',
            '  return <Modal opened onClose={() => undefined}>overlay</Modal>;',
            '}',
          ].join('\n')
        );
        try {
          expect(portalOffenders('RealOverlay', tmp, 'RealOverlay')).toEqual([]);
        } finally {
          fs.unlinkSync(tmp);
        }
      });

      test('importSourceOf resolves each import form, and reports absence as null', () => {
        const tmp = write(
          'imports',
          [
            "import Default from 'pkg-default';",
            "import { Named, Other as Aliased } from 'pkg-named';",
            "import * as Ns from 'pkg-ns';",
            'export function X() {',
            '  return <Named />;',
            '}',
          ].join('\n')
        );
        try {
          const src = sourceFileOf(tmp);
          expect(importSourceOf(src, 'Default')).toBe('pkg-default');
          expect(importSourceOf(src, 'Named')).toBe('pkg-named');
          // An ALIASED import binds the local name, which is what a tag resolves against.
          expect(importSourceOf(src, 'Aliased')).toBe('pkg-named');
          expect(importSourceOf(src, 'Other')).toBeNull();
          expect(importSourceOf(src, 'Ns')).toBe('pkg-ns');
          expect(importSourceOf(src, 'NotImported')).toBeNull();
        } finally {
          fs.unlinkSync(tmp);
        }
      });
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
