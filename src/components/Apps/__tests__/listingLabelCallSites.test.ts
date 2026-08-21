import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔒 THE ENROLMENT LEDGER for the two App-listing DISPLAY-LABEL rules.
 *
 * WHY THIS FILE EXISTS — measured, not hypothetical, and it is the same shape as
 * its sibling `appsStoreAccessCallSites.test.ts`. A tester reported that the store
 * preview showed a lowercase category and rating. The row they saw was one of
 * THIRTEEN surfaces rendering `app_listings.category` / `.content_rating` raw or
 * hand-derived, against five that were already mapped — the defect was never "this
 * row is wrong", it was "a display rule has unenrolled call sites".
 *
 * Fixing the thirteen does not remove that condition. An adversarial audit of the
 * fix reverted EVERY call site to raw and re-ran the cited suites: only 4 component
 * + 6 unit tests went red, so 10 of 17 sites were reachable-but-unasserted. Worse,
 * the fix's own mutation battery could not see it — every mutant targeted the two
 * helper modules, so each one died to the helpers' own unit tests whether or not a
 * single call site was wired correctly. The battery mutated the RULE, never its
 * ENROLMENT.
 *
 * So this asserts the RELATIONSHIP: across every App-Blocks surface, NO JSX
 * expression and NO Select-option `label` renders either field's raw value. It
 * fails when the ledger GROWS (a new surface that forgot the helper) and when it
 * SHRINKS (a mapped site reverted to raw) — including on the surfaces no component
 * test can reach.
 *
 * 🔴 WHY STRUCTURAL, AND WHAT THAT BUYS THAT BEHAVIOURAL COVER CANNOT. The browser
 * `component` project is REPORT-ONLY here — it runs as `preview / component-tests`,
 * off the blocking path — and three of the raw sites live where no component test
 * exists at all:
 *   - `pages/apps/[appBlockId]/index.tsx` — a Next page with `getServerSideProps` +
 *     `dbRead`, never import-testable; its sibling ledger already names it a known
 *     blind spot.
 *   - `components/Apps/RelatedListings.tsx` — its only test covers the pure
 *     selection helper and never mounts the component.
 *   - `components/Apps/AppListingDetailBody.tsx`'s meta-line badge, whose
 *     assertion lives in the report-only tier.
 * This file blocks. That is the whole point of it.
 *
 * 🔴 AND WHAT IT DOES NOT DO. A structural check proves a site does not render the
 * RAW field; it cannot prove the helper was passed the right argument, and it would
 * pass `marketplaceCategoryLabel(somethingElse)`. Behavioural cover lives alongside
 * and is deliberately NOT replaced by it — `__tests__/appListingDetailRows.test.ts`,
 * `__tests__/related-listings.test.ts`, `__tests__/offsiteSubmitFormConfig.test.ts`,
 * and the four browser suites. Read this as a reversion guard, not as proof of
 * correctness.
 */

const SRC = path.resolve(__dirname, '../../..');

/** Every App-Blocks surface that can render a listing to a human. */
const SCAN_ROOTS = ['components/Apps', 'components/AppBlocks', 'pages/apps'];

/** The two free-text columns whose display rule this ledger enforces. */
const GUARDED_FIELDS = ['category', 'contentRating'] as const;

/**
 * 🔴 ALIASED LOCALS — added because the first version of this scanner MISSED TWO
 * REAL SITES, and a call-site mutation battery is what found them.
 *
 * Matching the field NAME only sees `x.contentRating` / `{category}`. It does not
 * see a value that has been copied into a differently-named local first, and two
 * live sites do exactly that: `OffsiteReviewQueue`'s `derivedRating` (from
 * `deriveContentRatingFromAssets`) and `ManifestEditForm`'s `label: r` inside a
 * `map` over the rating set. Reverting either to raw left this file GREEN — the
 * ledger claimed a coverage it did not have.
 *
 * So a JSX child whose identifier merely ENDS in `Rating`/`Category` counts too.
 * The net is deliberately wider than the two columns: this runs in a test, so a
 * false positive costs one allowlist line with a reason, while a false negative
 * costs a lowercase enum on a user's screen. Asymmetric on purpose.
 */
const ALIAS_SUFFIX = /(^|[a-z])(Rating|Category|rating|category)$/;

/**
 * Files whose raw render is CORRECT and must stay raw. Each needs a reason — an
 * allowlist without one is how a real defect gets parked.
 */
const ALLOWED: Record<string, string> = {
  // The moderator's manifest DIFF panel prints the author's manifest as raw JSON.
  // The stored key is the thing under review there; mapping it would misrepresent
  // the document the author actually submitted.
  'components/Apps/reviewDiffPanels.tsx': 'raw manifest JSON diff — the key IS the subject',
};

/**
 * Receivers whose `.category` is a DIFFERENT DOMAIN, exempted by RECEIVER rather
 * than by file.
 *
 * 🔴 The distinction matters. A file-wide allowlist would stop scanning
 * `ReportTabs.tsx` entirely, so a real listing category rendered raw in that same
 * file would become invisible — an allowlist that silently widens is the second
 * unenrolment channel this ledger is supposed to close. Exempting the receiver
 * keeps every other expression in the file under the rule.
 *
 * `finding.category` is the automated-review FINDING's own taxonomy, rendered
 * beside `finding.severity` and `finding.diffStatus`. It has no relationship to
 * `app_listings.category` and no display-label map.
 */
const ALLOWED_RECEIVERS: Record<string, string> = {
  finding: 'agent-review finding taxonomy — not the marketplace category column',
};

function parseTsx(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Does this expression READ one of the guarded fields, with nothing applied?
 *
 * Matches a bare identifier (`{category}` — the destructured form two review-modal
 * badges used) and a property access (`{detail.contentRating}`, `{row.category}`).
 * A call expression is NOT matched: `{marketplaceCategoryLabel(detail.category)}`
 * is the fixed form, and it is the negative control below.
 *
 * 🔴 `?.` counts. `detail?.category` is the same raw read with a different token,
 * and `ts.PropertyAccessExpression` covers both — asserted in the controls so the
 * claim is measured rather than assumed.
 */
function rawFieldRead(node: ts.Node): string | null {
  let e: ts.Node = node;
  // Unwrap the shapes that do not change what reaches the DOM.
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isJsxExpression(e)
  ) {
    if (ts.isJsxExpression(e) && !e.expression) return null;
    e = (e as { expression?: ts.Node }).expression ?? e;
  }
  if (ts.isIdentifier(e)) {
    if ((GUARDED_FIELDS as readonly string[]).includes(e.text)) return e.text;
    if (e.text in ALLOWED_RECEIVERS) return null;
    if (ALIAS_SUFFIX.test(e.text)) return e.text;
    return null;
  }
  if (
    ts.isPropertyAccessExpression(e) &&
    (GUARDED_FIELDS as readonly string[]).includes(e.name.text)
  ) {
    // Receiver-scoped exemption (see ALLOWED_RECEIVERS) — everything else in the
    // same file stays under the rule.
    const recv = e.expression;
    if (ts.isIdentifier(recv) && recv.text in ALLOWED_RECEIVERS) return null;
    return e.name.text;
  }
  return null;
}

/** Every raw render of a guarded field in one source, as `line:field` strings. */
function findRawRenders(fileName: string, text: string): string[] {
  const sf = parseTsx(fileName, text);
  const hits: string[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    // (a) rendered as a JSX child — `<Badge>{row.category}</Badge>`
    if (ts.isJsxExpression(node) && node.parent && ts.isJsxElement(node.parent)) {
      const f = rawFieldRead(node);
      if (f) hits.push(`${at(node)}:${f}`);
    }
    // (b) used as a Select/Chip option label — `{ value: r, label: r }`
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'label') {
      const f = rawFieldRead(node.initializer);
      if (f) hits.push(`${at(node)}:${f}`);
      /**
       * 🔴 SHAPE RULE, not a name rule: an option label paired with a `value` in
       * the same literal must be a LOOKUP or a LITERAL, never a bare identifier.
       *
       * This is the rule that catches `ALLOWED_CONTENT_RATINGS.map((r) => ({
       * value: r, label: r }))` — the map variable is called `r`, so no amount of
       * field-name matching reaches it, and reverting that site left the whole
       * ledger green. Requiring the `value` sibling keeps the rule narrow: it only
       * fires on option-list literals, not on every `label:` prop in the tree.
       */
      const obj = node.parent;
      if (ts.isObjectLiteralExpression(obj) && ts.isIdentifier(node.initializer)) {
        const hasValueSibling = obj.properties.some(
          (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'value'
        );
        if (hasValueSibling) hits.push(`${at(node)}:bare-option-label`);
      }
      // The two near-miss re-derivations this PR removed: a label built by
      // transforming the key rather than by looking it up.
      const init = node.initializer;
      if (
        (ts.isCallExpression(init) &&
          ts.isPropertyAccessExpression(init.expression) &&
          /^(toUpperCase|toLowerCase)$/.test(init.expression.name.text)) ||
        (ts.isBinaryExpression(init) && /charAt|slice/.test(init.getText(sf)))
      ) {
        hits.push(`${at(node)}:derived-label`);
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return hits;
}

// ---------------------------------------------------------------------------
// 🔴 VALIDATE THE INSTRUMENT BEFORE READING ITS VERDICT.
//
// The assertion this file exists for is a ZERO, and a reassuring zero is
// indistinguishable from a scanner wired to nothing. Both controls below run
// against synthetic sources, so they cannot go stale when the real tree changes.
// ---------------------------------------------------------------------------
describe('🔴 the scanner (negative + positive controls)', () => {
  it('POSITIVE CONTROL: it FINDS every raw shape this ledger is meant to catch', () => {
    const bad = `
      export function S(p: { category: string; contentRating: string }) {
        const { category } = p;
        return (
          <div>
            <Badge>{p.category}</Badge>
            <Badge>{p.contentRating}</Badge>
            <Badge>{category}</Badge>
            <Badge>{p?.contentRating}</Badge>
            <Select data={RATINGS.map((r) => ({ value: r, label: r.toUpperCase() }))} />
            <Select data={CATS.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) }))} />
          </div>
        );
      }`;
    const hits = findRawRenders('bad.tsx', bad).map((h) => h.split(':')[1]);
    // Four raw reads (incl. the optional-chained one) + both derived labels.
    expect(hits.filter((h) => h === 'category')).toHaveLength(2);
    expect(hits.filter((h) => h === 'contentRating')).toHaveLength(2);
    expect(hits.filter((h) => h === 'derived-label')).toHaveLength(2);
  });

  /**
   * 🔴 THE REGRESSION CONTROL for this file's own measured blind spot. Both
   * shapes below are real sites that the name-matching version scored SURVIVED —
   * `derivedRating` in the review queue and `label: r` in the manifest editor.
   * If either stops being caught, the ledger is lying about its coverage again.
   */
  it('POSITIVE CONTROL: it catches an ALIASED local and a bare option label', () => {
    const aliased = `
      export function S() {
        const derivedRating = deriveContentRatingFromAssets(assets);
        return (
          <div>
            <Badge>{derivedRating}</Badge>
            <Select data={[...RATINGS].map((r) => ({ value: r, label: r }))} />
          </div>
        );
      }`;
    const hits = findRawRenders('aliased.tsx', aliased).map((h) => h.split(':')[1]);
    expect(hits).toContain('derivedRating');
    expect(hits).toContain('bare-option-label');
  });

  it('the bare-option-label rule needs a `value` SIBLING (it is not "every label:")', () => {
    // A `label` prop that is not part of an option literal is ordinary React and
    // must not be flagged, or the rule would be allowlisted into uselessness.
    const notAnOption = `
      export function S() {
        return <Tooltip label={heading}><Button label={actionLabel} /></Tooltip>;
      }`;
    expect(findRawRenders('notAnOption.tsx', notAnOption)).toEqual([]);
  });

  it('NEGATIVE CONTROL: it does NOT flag the mapped form', () => {
    const good = `
      export function S(p: { category: string; contentRating: string }) {
        return (
          <div>
            <Badge>{marketplaceCategoryLabel(p.category)}</Badge>
            <Badge>{offsiteContentRatingLabel(p.contentRating)}</Badge>
            <Select data={RATINGS.map((r) => ({ value: r, label: offsiteContentRatingLabel(r) }))} />
          </div>
        );
      }`;
    expect(findRawRenders('good.tsx', good)).toEqual([]);
  });

  it('does not mistake a NON-rendering use of the field for a render', () => {
    // Filter values, query inputs, mutation args and comparisons are not renders —
    // a scanner that flagged them would be unusable and would get allowlisted away.
    const neutral = `
      export function S(p: { category: string; contentRating: string }) {
        const filter = isMarketplaceCategory(p.category) ? p.category : undefined;
        mutate({ category: p.category, contentRating: p.contentRating });
        if (p.category !== other.category) log(p.contentRating);
        return <Select value={p.category} data={OPTIONS} />;
      }`;
    expect(findRawRenders('neutral.tsx', neutral)).toEqual([]);
  });
});

const SCANNED = SCAN_ROOTS.flatMap((root) => walk(path.join(SRC, root))).map((file) => ({
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  raw: fs.readFileSync(file, 'utf8'),
}));

describe('🔒 no App-Blocks surface renders a raw category / contentRating', () => {
  /**
   * 🔴 A ROW FLOOR ON THE SCANNER ITSELF. Without it, a `SCAN_ROOTS` typo or a
   * directory rename turns this whole file into a green no-op — the exact failure
   * mode the ledger is here to prevent, one level up. The number is deliberately
   * well below the real count so a normal deletion cannot trip it.
   */
  it('POSITIVE CONTROL: the scan actually visited the App-Blocks tree', () => {
    expect(SCANNED.length).toBeGreaterThan(60);
    const rels = SCANNED.map((s) => s.rel);
    // Named files, so a root that silently stops resolving is caught by identity
    // and not only by count.
    expect(rels).toContain('components/Apps/appListingDetailRows.ts');
    expect(rels).toContain('components/Apps/OffsiteReviewQueue.tsx');
    expect(rels).toContain('pages/apps/[appBlockId]/index.tsx');
  });

  it('🔴 every render goes through a display-label helper', () => {
    const offenders = SCANNED.flatMap(({ rel, raw }) =>
      rel in ALLOWED ? [] : findRawRenders(rel, raw).map((h) => `${rel}:${h}`)
    );
    // Listed in full on failure: the message IS the fix instructions.
    expect(offenders).toEqual([]);
  });

  it('the allowlist stays small and every entry still exists', () => {
    // An allowlist that can grow silently is a second unenrolment channel.
    expect(Object.keys(ALLOWED)).toHaveLength(1);
    expect(Object.keys(ALLOWED_RECEIVERS)).toEqual(['finding']);
    for (const rel of Object.keys(ALLOWED)) {
      expect(fs.existsSync(path.join(SRC, rel))).toBe(true);
      expect(ALLOWED[rel].length).toBeGreaterThan(20);
    }
    for (const reason of Object.values(ALLOWED_RECEIVERS)) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  /**
   * 🔴 The receiver exemption is scoped, and this proves it — otherwise "exempt by
   * receiver" would be indistinguishable from "exempt the whole file", which is
   * the weaker thing I explicitly did not want.
   */
  it('the receiver exemption does NOT disable the rest of its file', () => {
    const mixed = `
      export function S() {
        return (
          <div>
            <Badge>{finding.category}</Badge>
            <Badge>{listing.category}</Badge>
          </div>
        );
      }`;
    const hits = findRawRenders('mixed.tsx', mixed);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/category$/);
  });
});
