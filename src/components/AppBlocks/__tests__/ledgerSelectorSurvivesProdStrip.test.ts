import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE FULL-BLEED LEDGER MUST SURVIVE THE PRODUCTION COMPILER'S ATTRIBUTE STRIP.
 *
 * This is a SEAM guard. Two files were each correct on their own and broken
 * together, and every existing test was scoped to one side of the seam:
 *
 *   · `next.config.mjs` strips `data-testid` from the DOM in production builds
 *     (`compiler.reactRemoveProperties`, gated on `NODE_ENV === 'production'`).
 *   · `src/styles/globals.css` keyed the opt-out ledger on
 *     `[data-testid='app-page-frame'][data-block-id='…']`.
 *
 * So on the live site the compound selector matched ZERO elements, and
 * `playable-collections` — an app whose every open-collection view mode is
 * uncapped by the app itself — rendered letterboxed at the 1600px cap, the exact
 * outcome the rule's own comment says it exists to prevent. Measured on
 * civitai.com/apps/run/playable-collections (image `20260902233645-bbbe837`):
 * the rule was present in the deployed CSS verbatim; 0 elements matched the
 * compound selector; 1 matched `[data-block-id='playable-collections']`; the
 * whole page carried 0 `data-testid` attributes across 615 elements while 209
 * elements carried other `data-*` attributes; the computed
 * `--app-page-max-width` on the capped box was `1600px`.
 *
 * 🔴 WHY NO TEST COULD SEE IT, AND WHY THIS ONE CAN. Every tier runs with
 * `NODE_ENV !== 'production'`, so the testid is present and the selector matches
 * — including `PageBlockHostMaxWidth.browser.test.tsx`, which INJECTS a rule of
 * that exact shape and measures full-bleed at 2560x1080. That suite is not
 * wrong; it is structurally blind, because its environment fixes the one
 * dimension the defect lives on. A rendered test can never see this. The only
 * thing that can is a check that reads the two CONFIGURATIONS and compares them,
 * which is what this file does — it restates neither side.
 *
 * WHAT IS PINNED HERE:
 *   · the strip list is parseable out of `next.config.mjs`, non-empty, ENTIRELY
 *     readable (every array element a plain literal — a mixed array would let
 *     this guard grade a SHORTER list than production applies), and
 *     production-gated — asserted on the `compiler:` property's OWN conditional,
 *     not on "the words appear earlier in the file" (the reason the other tiers
 *     cannot see this defect)
 *   · at least one ledger rule is parseable out of `globals.css`
 *   · NO attribute any ledger selector depends on is removed by that strip list
 *   · every ledger selector's attributes are stamped TOGETHER ON ONE ELEMENT by
 *     `PageBlockHost.tsx` — surviving the strip is worthless if nothing renders
 *     them, and a compound selector is satisfied by neither half alone
 *
 *   Those last two are applied to all THREE surfaces that carry a selector: the
 *   shipped rules, the ledger's own "HOW TO ADD ONE" template, and the
 *   publisher-facing HOW-TO in `docs/features/app-blocks.md` — because an example
 *   re-creates the bug on the next entry, and it can do so through EITHER
 *   mechanism (a stripped attribute, or a misspelled/renamed one that nothing
 *   stamps). A guard on only one of the two would be narrower than this sentence.
 *
 * FAILS CLOSED. An unparseable config, an empty strip list, or zero parsed ledger
 * rules is a FAILURE, not a quiet pass: a reassuring zero here is indistinguishable
 * from a guard wired to nothing. If `reactRemoveProperties` is ever removed
 * deliberately, delete or re-point this file in the same commit rather than
 * letting it fail — but do that knowingly.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const NEXT_CONFIG = path.join(REPO_ROOT, 'next.config.mjs');
const GLOBALS_CSS = path.join(REPO_ROOT, 'src/styles/globals.css');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/PageBlockHost.tsx');
/** The publisher-facing HOW-TO. The copy app authors actually read. */
const PUBLISHER_DOC = path.join(REPO_ROOT, 'docs/features/app-blocks.md');

const repoPath = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

function read(file: string): string {
  // Prove the path before trusting anything derived from it — a comparison
  // against an absent operand reports SAME, not MISSING, so a renamed file would
  // turn every assertion below into a vacuous pass on an empty string.
  expect(fs.existsSync(file), `${repoPath(file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip `/* *\/` block comments and `//` line comments. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Collapse whitespace so an assertion pins the EXPRESSION, not its formatting. */
function norm(src: string): string {
  return src.replace(/\s+/g, ' ').trim();
}

/**
 * `next.config.mjs`, PARSED — not searched.
 *
 * 🔴 A REAL PARSE, BECAUSE THE TEXT VERSION WAS SATISFIABLE BY AN UNRELATED LINE.
 * The gate assertion used to slice the file at the first `reactRemoveProperties`
 * and ask whether `process.env.NODE_ENV === 'production'` appeared anywhere in
 * the prefix. `next.config.mjs:9` is `const isProd = process.env.NODE_ENV ===
 * 'production';` — 174 lines earlier and unrelated to the compiler block — which
 * satisfied it on its own. Measured: rewriting `compiler:` so the strip applies
 * UNCONDITIONALLY (ternary and NODE_ENV test both deleted) left the guard 5/5
 * green. A parse can ask about the strip's OWN gate; a substring search cannot.
 *
 * Parsing also makes the whole file comment-proof for free, which is the other
 * half: a commented-out `reactRemoveProperties` earlier in the file is invisible
 * to the parser but would be the FIRST hit for any text search.
 *
 * Still not an import: `next.config.mjs` pulls in the whole Next build pipeline
 * as a side effect. `ScriptKind.JS` reads it as the plain ESM module it is.
 */
function nextConfigAst(): ts.SourceFile {
  return ts.createSourceFile(
    NEXT_CONFIG,
    read(NEXT_CONFIG),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
}

/** The static name of an object-literal member, or `null` for a computed one. */
function memberName(p: ts.ObjectLiteralElementLike): string | null {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  return null;
}

/**
 * Every `key: value` assignment named `name`, at any depth.
 *
 * Returns ALL of them rather than the first: callers assert the count, so a
 * second `compiler:` or `reactRemoveProperties:` (a second config branch, a
 * conditional spread) fails loudly instead of being graded arbitrarily.
 */
function propertyAssignments(sf: ts.SourceFile, name: string): ts.PropertyAssignment[] {
  const out: ts.PropertyAssignment[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAssignment(n) && memberName(n) === name) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The property-name patterns `reactRemoveProperties` deletes in a production
 * build, read out of `next.config.mjs`.
 */
function stripPatterns(): string[] {
  const hits = propertyAssignments(nextConfigAst(), 'reactRemoveProperties');
  expect(
    hits.length,
    `next.config.mjs declares \`reactRemoveProperties\` ${hits.length} times, not once. This ` +
      'guard exists to compare that strip list against the full-bleed opt-out ledger in ' +
      'globals.css; with zero it can prove nothing, and with several it would be grading an ' +
      'arbitrary one. If `reactRemoveProperties` was removed on purpose, delete or re-point ' +
      'this file in the same commit.'
  ).toBe(1);

  const init = hits[0].initializer;
  expect(
    ts.isObjectLiteralExpression(init),
    '`reactRemoveProperties` is no longer an inline object literal, so its property list lives ' +
      'somewhere this guard is not looking. Re-point the parse rather than letting the check ' +
      'pass on a value it cannot read.'
  ).toBe(true);

  const list = (init as ts.ObjectLiteralExpression).properties.find(
    (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && memberName(p) === 'properties'
  );
  expect(
    list?.initializer !== undefined && ts.isArrayLiteralExpression(list.initializer),
    '`reactRemoveProperties.properties` is not an inline array literal in next.config.mjs. The ' +
      'literals moved behind a variable this parse cannot follow — fix the parse; an unreadable ' +
      'strip list would let every ledger selector pass unchecked.'
  ).toBe(true);

  const elements = (list!.initializer as ts.ArrayLiteralExpression).elements;
  const patterns = elements
    .filter((e): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
      ts.isStringLiteralLike(e)
    )
    .map((e) => e.text);

  // 🔴 EVERY ELEMENT MUST BE READABLE, NOT JUST SOME OF THEM. Filtering to the
  // string literals and grading what survives FAILS OPEN on a mixed array: a
  // spread, an identifier, a template with a substitution or a conditional is
  // silently dropped, and this guard then certifies the ledger against a strip
  // list SHORTER than the one production applies. Measured, before this check
  // existed: with `properties: ['^data-testid$', ...EXTRA_STRIPS]` where
  // `EXTRA_STRIPS = ['^data-app-page-frame$']`, this file reported 7 passed / 7
  // while production was stripping the very attribute the ledger had just been
  // re-keyed onto — i.e. it re-certified the shipped defect as fixed. Same
  // fail-closed direction as the two assertions above it.
  expect(
    patterns.length,
    `next.config.mjs lists ${elements.length} entries in \`reactRemoveProperties.properties\` ` +
      `but only ${patterns.length} of them are plain string literals this parse can read ` +
      `(unreadable: ${elements
        .filter((e) => !ts.isStringLiteralLike(e))
        .map((e) => norm(e.getText()))
        .join(', ')}). A spread, a variable or an interpolated template hides part of the strip ` +
      'list, and everything below would then compare the ledger against a SHORTER list than ' +
      'production applies — passing while an attribute the ledger depends on is being removed. ' +
      'Inline the entries, or extend this parse to follow them; do not let it grade a subset.'
  ).toBe(elements.length);

  expect(
    patterns,
    'next.config.mjs declares `reactRemoveProperties` with an EMPTY property list. Either the ' +
      'literals moved behind a variable this parse cannot follow (then fix the parse), or the ' +
      'strip was disabled (then this guard is obsolete). An empty list would let every ledger ' +
      'selector pass unchecked, which is the reassuring-zero failure this file is about.'
  ).not.toHaveLength(0);
  return patterns;
}

/**
 * The `compiler:` value's own conditional — the strip's actual gate.
 *
 * `whenFalse` is deliberately NOT returned: the assertion that used to read it
 * was unreachable (see the note in the gate test), and a field nobody reads
 * invites the next person to re-add an assertion that can never fire.
 */
function compilerGate(): { condition: string; whenTrue: string } {
  const hits = propertyAssignments(nextConfigAst(), 'compiler');
  expect(
    hits.length,
    `next.config.mjs declares \`compiler:\` ${hits.length} times, not once. This guard reads that ` +
      "one property's own gate; with zero there is nothing to read, and with several it would be " +
      'grading an arbitrary branch while another one ships.'
  ).toBe(1);

  const init = hits[0].initializer;
  expect(
    ts.isConditionalExpression(init),
    "the `compiler:` value in next.config.mjs is no longer a `NODE_ENV === 'production' ? … : …` " +
      'conditional, so the `reactRemoveProperties` attribute strip is NOT gated on a production ' +
      "build by its own expression. This guard's whole premise — and the reason no rendered test " +
      'tier can observe a ledger selector keyed on a stripped attribute — is that the strip ' +
      'happens ONLY in production. If the strip is now unconditional, every tier will start ' +
      'seeing the stripped DOM and this file needs rewriting rather than relaxing. NOTE: this ' +
      "assertion is about the `compiler:` property ITSELF; an unrelated `NODE_ENV === 'production'` " +
      'elsewhere in the file must not be able to satisfy it.'
  ).toBe(true);

  const c = init as ts.ConditionalExpression;
  return {
    condition: norm(c.condition.getText()),
    whenTrue: norm(c.whenTrue.getText()),
  };
}

/** A run of consecutive attribute selectors that includes `[data-block-id=…]`. */
type LedgerSelector = { text: string; attrs: string[] };

/**
 * Every ledger-shaped attribute-selector run in `css`, with the attribute names
 * it depends on.
 *
 * A "run" is one or more adjacent `[…]` selectors — the compound shape the ledger
 * uses. Runs that do not name `data-block-id` are not ledger rules and are
 * skipped, which is what keeps unrelated rules like `#__next:has([data-adhesive-ad])`
 * out of this guard's scope.
 */
function ledgerSelectors(css: string): LedgerSelector[] {
  const RUN = /(?:\[\s*[A-Za-z_][\w-]*(?:\s*[~|^$*]?=\s*(?:'[^']*'|"[^"]*"|[^\]\s]+))?\s*\]\s*)+/g;
  const out: LedgerSelector[] = [];
  for (const m of css.matchAll(RUN)) {
    const text = m[0].trim();
    if (!/\[\s*data-block-id\s*[~|^$*]?=/.test(text)) continue;
    out.push({
      text,
      attrs: [...text.matchAll(/\[\s*([A-Za-z_][\w-]*)/g)].map((a) => a[1]),
    });
  }
  return out;
}

/**
 * Which attributes of `selector` production removes, given `patterns`.
 * The unit under test — exercised against a synthetic known-bad input below so
 * this file is never a check that has only ever been watched to pass.
 */
function strippedAttrsIn(selector: LedgerSelector, patterns: string[]): string[] {
  return selector.attrs.filter((attr) => patterns.some((p) => new RegExp(p).test(attr)));
}

/**
 * The attribute names each JSX element in `PageBlockHost.tsx` stamps, one entry
 * per element.
 *
 * 🔴 PER-ELEMENT, BECAUSE A COMPOUND SELECTOR IS A RELATIONSHIP AND A WHOLE-FILE
 * SEARCH CANNOT SEE ONE. This used to be `host.includes(`${attr}=`)` over the
 * file's text, under a message claiming the attribute was "stamped on its root".
 * The implementation only asked whether the characters occurred ANYWHERE.
 * Measured: moving `data-app-page-frame=""` off the host root onto the
 * `app-page-content` wrapper re-creates the shipped production defect exactly —
 * `[data-app-page-frame][data-block-id='…']` matches zero elements, because the
 * two halves are now on different boxes — and the whole node tier stayed
 * BYTE-IDENTICALLY green. Only the report-only browser tier caught it. (Neither
 * tier blocks a merge — `main` requires no status check in this repo — so what a
 * node-tier guard buys is an honest verdict on a push to `main` and an annotation
 * a reviewer has to read, not a door that stays shut.) Relocation is the mutation
 * this shape exists to catch, and it survived the guard written against it.
 *
 * 🔴 A SPREAD'S CONTENTS ARE NOT COUNTED, DELIBERATELY. `{...props}` could carry
 * anything, so crediting a spread-bearing element with an attribute it might be
 * passing would be a guess in the PASSING direction. Its EXPLICITLY WRITTEN
 * attributes still count, so such an element can satisfy a selector on those; what
 * cannot satisfy one is an attribute arriving only via the spread. Fail-closed on
 * the unknown half — the right way round for a guard.
 */
function stampedAttributeSets(): string[][] {
  const sf = ts.createSourceFile(HOST, read(HOST), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[][] = [];
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      out.push(n.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText()));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Does SOME ONE element stamp every attribute `selector` chains together?
 * The unit under test for the relationship claim — exercised against both a
 * satisfying and a split-across-two-elements input in the control below.
 */
function stampedTogether(selector: LedgerSelector, elements: string[][]): boolean {
  return elements.some((el) => selector.attrs.every((a) => el.includes(a)));
}

describe('the full-bleed opt-out ledger survives the production attribute strip', () => {
  it('the strip list is parseable, non-empty, and gated on a production build', () => {
    const patterns = stripPatterns();
    expect(patterns.length).toBeGreaterThan(0);

    // The production gate is WHY every other tier is blind to this, so it is
    // part of the claim rather than background. If the strip ever became
    // unconditional, the browser suite would start failing on its own and this
    // guard's framing would need rewriting.
    //
    // 🔴 TWO ASSERTIONS, ON THE `compiler:` PROPERTY'S OWN CONDITIONAL: the
    // condition must BE the production test, and the strip must live in the branch
    // that condition selects. A substring search over the file's prefix could make
    // neither claim — `const isProd = process.env.NODE_ENV === 'production'` on
    // line 9 satisfied the old spelling by itself, so an unconditional strip
    // passed 5/5.
    //
    // 🔴 THERE USED TO BE A THIRD, `whenFalse` NOT CONTAINING THE STRIP, AND IT WAS
    // UNREACHABLE. Both shapes it named are consumed earlier, so its message could
    // never print. Measured: the strip in BOTH branches dies in `stripPatterns()`
    // — which this test calls at its very first line, before any of this — with
    // "declares `reactRemoveProperties` 2 times, not once" (5 failed / 2 passed);
    // the strip in the non-production branch ONLY dies on the `whenTrue` assertion
    // below (1 failed / 6 passed). With exactly one `reactRemoveProperties`, the
    // only inputs that could still have reached the deleted assertion were text
    // coincidences in `getText()` — false positives of the spelled-not-structural
    // kind this file exists to remove. A coverage sentence wider than what is
    // actually asserted reads as protection while providing none, so both the
    // assertion and its share of this comment are gone rather than left standing.
    const gate = compilerGate();
    expect(
      gate.condition,
      'the `compiler:` block in next.config.mjs is gated on something other than ' +
        "`process.env.NODE_ENV === 'production'`. The attribute strip's blindness to every test " +
        'tier follows from that exact condition; a different one means this file is reasoning ' +
        'about a build mode that no longer matches reality. If you merely hoisted the test into ' +
        'a named constant (`isProd`), re-point this assertion at that constant in the same ' +
        'commit rather than relaxing it into a substring search — that is the spelling an ' +
        'unrelated line 174 lines earlier was already able to satisfy on its own.'
    ).toBe("process.env.NODE_ENV === 'production'");
    expect(
      gate.whenTrue,
      'the `reactRemoveProperties` strip is no longer in the branch the production condition ' +
        'SELECTS. Either it moved to the non-production branch (then every tier now runs with ' +
        'the stripped DOM and this guard is inverted), or it left the conditional entirely.'
    ).toContain('reactRemoveProperties');
  });

  /**
   * 🔴 NEGATIVE CONTROL — can this check go red at all?
   *
   * The known-bad attribute is DERIVED from the parsed patterns (anchors stripped
   * off a literal pattern), not restated as `data-testid`, so the control moves
   * with the config instead of pinning today's value. A check that has only ever
   * been watched to pass is a claim about the check.
   */
  it('CONTROL — a ledger selector using a stripped attribute is reported as a violation', () => {
    const patterns = stripPatterns();
    // Pair the derived name with the pattern it came from — filtering first and
    // indexing back into `patterns` would misalign the moment one is dropped.
    const samples = patterns
      .map((p) => ({ pattern: p, name: p.replace(/^\^/, '').replace(/\$$/, '') }))
      .filter(
        ({ pattern, name }) => /^[A-Za-z_][\w-]*$/.test(name) && new RegExp(pattern).test(name)
      )
      .map(({ name }) => name);
    expect(
      samples,
      'no literal attribute name could be derived from the parsed strip patterns, so this ' +
        'control cannot build a known-bad input and the checks below have no negative control. ' +
        'Add a derivation for the new pattern shape rather than deleting this test.'
    ).not.toHaveLength(0);

    const bad = ledgerSelectors(`[${samples[0]}='app-page-frame'][data-block-id='x'] { }`);
    expect(
      bad,
      'the ledger-selector extraction did not even match a synthetic ledger rule'
    ).toHaveLength(1);
    expect(
      strippedAttrsIn(bad[0], patterns),
      'the strip check did NOT flag a selector built from an attribute the production compiler ' +
        'is configured to remove. The check is inert — fix it before reading any verdict below.'
    ).toEqual([samples[0]]);

    // …and green on the shape the ledger is supposed to use.
    const good = ledgerSelectors(`[data-app-page-frame][data-block-id='x'] { }`);
    expect(good).toHaveLength(1);
    expect(strippedAttrsIn(good[0], patterns)).toEqual([]);
  });

  /**
   * 🔴 SECOND NEGATIVE CONTROL — for the RELATIONSHIP check specifically.
   *
   * `stampedTogether` is the half that the old whole-file substring search got
   * wrong, so it gets its own known-bad input rather than riding on the strip
   * control above. The known-bad here is the exact defect shape: both attributes
   * present, on DIFFERENT elements.
   */
  it('CONTROL — attributes split across two elements do NOT satisfy a compound selector', () => {
    const [selector] = ledgerSelectors(`[data-app-page-frame][data-block-id='x'] { }`);
    expect(selector, 'the ledger-selector extraction did not match a synthetic rule').toBeDefined();

    expect(
      stampedTogether(selector, [
        ['data-testid', 'data-app-page-frame', 'data-block-id', 'data-fit'],
      ]),
      'the relationship check did not accept an element that really does stamp both halves — it ' +
        'is over-strict and would fail on a correct host. Fix it before reading any verdict.'
    ).toBe(true);

    expect(
      stampedTogether(selector, [
        ['data-testid', 'data-block-id'],
        ['data-testid', 'data-app-page-frame'],
      ]),
      'the relationship check ACCEPTED a host that stamps the two halves of a compound selector ' +
        'on two DIFFERENT elements — the relocation defect. The check is inert; it has ' +
        'regressed to asking whether each token appears somewhere. Fix it before reading any ' +
        'verdict below.'
    ).toBe(false);

    expect(
      stampedTogether(selector, [['data-testid', 'data-block-id']]),
      'the relationship check accepted a host missing one half of the selector entirely.'
    ).toBe(false);
  });

  it('🔴 no shipped ledger rule depends on an attribute production strips', () => {
    const patterns = stripPatterns();
    const shipped = ledgerSelectors(stripComments(read(GLOBALS_CSS)));

    // Minimum parsed-rule count. Zero would make every assertion below vacuous,
    // and a broken regex reads exactly like "nothing to check".
    expect(
      shipped.length,
      'zero `[data-block-id=…]` ledger rules were parsed out of src/styles/globals.css. Either ' +
        'the full-bleed ledger was emptied (then this guard and the membership expectation in ' +
        '__tests__/pageBlockHostMaxWidth.test.ts should be retired together, deliberately), or ' +
        'this parse no longer reaches the rules. Failing rather than passing on zero is the point.'
    ).toBeGreaterThanOrEqual(1);

    const violations = shipped
      .map((s) => ({ selector: s.text, stripped: strippedAttrsIn(s, patterns) }))
      .filter((v) => v.stripped.length > 0);

    expect(
      violations,
      'a full-bleed ledger rule in src/styles/globals.css is keyed on an attribute that ' +
        '`next.config.mjs` REMOVES from the production DOM ' +
        `(${patterns.join(', ')}). The rule ships in the stylesheet and matches nothing on the ` +
        'live site, so the app it excuses from the ultrawide cap is letterboxed in production ' +
        'while every test tier passes — they all run with NODE_ENV != production, where the ' +
        'attribute still exists. Key the rule on a marker the compiler keeps, such as ' +
        '`data-app-page-frame`, which PageBlockHost stamps beside `data-block-id`.'
    ).toEqual([]);
  });

  /**
   * The ledger's own worked example is the thing the next person copies. If it
   * teaches the stripped spelling, the next entry re-creates the production-only
   * defect — so the template is held to the same rules as the rules: it must
   * survive the strip AND name attributes something actually stamps together.
   * The shipped-rule guards below run over `stripComments()`d CSS and therefore
   * cannot see this template at all.
   */
  it('🔴 the ledger’s HOW-TO-ADD-ONE template teaches a selector that survives production AND matches something', () => {
    const patterns = stripPatterns();
    const raw = read(GLOBALS_CSS);
    const documented = ledgerSelectors(raw);
    expect(
      documented.length,
      'no ledger-shaped selector was found in src/styles/globals.css at all, comments included ' +
        '— the template and the rules both went missing, or this parse is broken.'
    ).toBeGreaterThanOrEqual(1);

    const bad = documented
      .map((s) => ({ selector: s.text, stripped: strippedAttrsIn(s, patterns) }))
      .filter((v) => v.stripped.length > 0);

    expect(
      bad,
      'the full-bleed ledger documentation in src/styles/globals.css shows a selector keyed on ' +
        'an attribute production strips. Even if no shipped rule uses that shape today, the ' +
        'example is what the next entry is copied from, so it reproduces the defect one commit ' +
        'later. Update the "HOW TO ADD ONE" template as well as the rules.'
    ).toEqual([]);

    const elements = stampedAttributeSets();
    expect(
      elements.length,
      'no JSX elements were parsed out of PageBlockHost.tsx at all, so the check below would be ' +
        'vacuous in the PASSING direction.'
    ).toBeGreaterThan(0);

    expect(
      documented.filter((s) => !stampedTogether(s, elements)).map((s) => s.text),
      'the "HOW TO ADD ONE" template in src/styles/globals.css chains attributes that NO SINGLE ' +
        'element in PageBlockHost.tsx stamps together, so an entry copied from it matches ' +
        'nothing. A misspelling reaches this assertion and not the strip one above (nothing ' +
        'strips a misspelling); so does a rename that updated the shipped rules and the host but ' +
        'not the comment they are copied from.'
    ).toEqual([]);
  });

  /**
   * 🔴 AND THE PUBLISHER-FACING COPY, WHICH IS THE ONE APP AUTHORS ACTUALLY READ.
   *
   * `docs/features/app-blocks.md` carries the same "asking for full bleed"
   * recipe. It shipped the production-inert `data-testid` spelling and nothing
   * guarded it — a maintainer following it writes a rule that matches nothing on
   * the live site, which is precisely the defect this file was created for,
   * re-entering through the door marked documentation. This assertion is what
   * lets that doc claim it is checked.
   *
   * 🔴 BOTH MECHANISMS, NOT JUST THE STRIP. A documented selector can match zero
   * elements two ways, and this file's own header names both: an attribute the
   * compiler removes, or attributes nothing stamps TOGETHER. Checking only the
   * first is a guard narrower than the sentence describing it. Measured, before
   * the second check existed: changing the recipe to
   * `[data-app-page-fram][data-block-id='your-app-slug']` — one dropped `e` — left
   * this file 7 passed / 7, because a typo'd attribute is stripped by nothing. An
   * author copying it gets a rule matching zero elements and a letterboxed app:
   * the same user-visible outcome as the shipped bug, through the other door. The
   * realistic trigger is a RENAME, where `globals.css` and `PageBlockHost.tsx` are
   * both pinned and the doc is pinned by nothing.
   */
  it('🔴 the publisher HOW-TO in docs/features/app-blocks.md teaches a selector that survives production AND matches something', () => {
    const patterns = stripPatterns();
    const documented = ledgerSelectors(read(PUBLISHER_DOC));
    expect(
      documented.length,
      'no `[data-block-id=…]` selector was found in docs/features/app-blocks.md. The full-bleed ' +
        'opt-out recipe is the only documented way out of the ultrawide cap; if it was removed, ' +
        'retire this assertion deliberately rather than letting it pass on an empty parse.'
    ).toBeGreaterThanOrEqual(1);

    const bad = documented
      .map((s) => ({ selector: s.text, stripped: strippedAttrsIn(s, patterns) }))
      .filter((v) => v.stripped.length > 0);

    expect(
      bad,
      'the full-bleed recipe in docs/features/app-blocks.md shows a selector keyed on an ' +
        `attribute that next.config.mjs REMOVES from the production DOM (${patterns.join(
          ', '
        )}). ` +
        'This is the copy app authors read, so it teaches a rule that works in every preview and ' +
        'matches nothing on civitai.com. Key it on a marker the compiler keeps, such as ' +
        '`data-app-page-frame`.'
    ).toEqual([]);

    const elements = stampedAttributeSets();
    expect(
      elements.length,
      'no JSX elements were parsed out of PageBlockHost.tsx at all, so the check below would be ' +
        'vacuous in the PASSING direction — the reassuring-zero shape this file refuses.'
    ).toBeGreaterThan(0);

    expect(
      documented.filter((s) => !stampedTogether(s, elements)).map((s) => s.text),
      'the full-bleed recipe in docs/features/app-blocks.md chains attributes that NO SINGLE ' +
        'element in PageBlockHost.tsx stamps together, so a rule copied from it matches nothing — ' +
        'surviving the production strip is worthless if nothing renders the attributes. A typo in ' +
        'the documented attribute name reaches this assertion and not the strip one (nothing ' +
        'strips a misspelling), and a rename of the real marker reaches it too, because this doc ' +
        'is the one copy of the recipe that no other guard pins. Spell the attributes exactly as ' +
        'PageBlockHost stamps them, on the element that stamps them both.'
    ).toEqual([]);
  });

  /**
   * Surviving the strip is only half of it: a ledger keyed on attributes nobody
   * renders TOGETHER matches nothing for a different reason, and looks just as fine.
   *
   * 🔴 THE CLAIM IS THE RELATIONSHIP — BOTH ATTRIBUTES ON ONE ELEMENT — NOT THE
   * PRESENCE OF EACH TOKEN SOMEWHERE. `[data-app-page-frame][data-block-id='…']`
   * is a compound selector: an element carrying only one half matches it exactly
   * as poorly as an element carrying neither. The sibling guard
   * `pageBlockHostMaxWidth.test.ts` states the same thing from the other side, on
   * the parsed frame element.
   */
  it('🔴 each ledger selector’s attributes are stamped TOGETHER on ONE PageBlockHost element', () => {
    const shipped = ledgerSelectors(stripComments(read(GLOBALS_CSS)));
    expect(
      shipped.length,
      'zero ledger rules parsed — see the strip test above'
    ).toBeGreaterThanOrEqual(1);

    const elements = stampedAttributeSets();
    expect(
      elements.length,
      'no JSX elements were parsed out of PageBlockHost.tsx at all. Zero would make the check ' +
        'below vacuous in the passing direction for every selector, which is the reassuring-zero ' +
        'shape this file exists to refuse.'
    ).toBeGreaterThan(0);

    const unmatched = shipped.filter((s) => !stampedTogether(s, elements)).map((s) => s.text);

    expect(
      unmatched,
      'a full-bleed ledger rule in src/styles/globals.css chains attributes that NO SINGLE ' +
        'element in PageBlockHost.tsx stamps together, so the rule matches nothing — the same ' +
        'silent outcome as keying it on a stripped attribute, arrived at from the other side. ' +
        'Both halves existing somewhere in the file is NOT enough: splitting them across the ' +
        'host root and the `app-page-content` wrapper is exactly the relocation that re-creates ' +
        'the shipped production defect, and the whole node tier stayed green under it until ' +
        'this assertion was written per-element. Either stamp every attribute the selector ' +
        'chains on the SAME element, or re-key the ledger onto attributes that are.'
    ).toEqual([]);
  });
});
