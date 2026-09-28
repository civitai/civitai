import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// The repo's shared TypeScript comment stripper, used ONLY on TS input here — see `code()`
// for why the mixed CSS+TS corpus keeps a narrower local one.
import { stripComments as stripTsComments } from '../../../../test/strip-comments';

/**
 * THE FULL-PAGE APP BLOCK'S WIDTH — the SOURCE half.
 * (`PageBlockHostMaxWidth.browser.test.tsx` is the MEASURED half. Neither half is a
 * merge gate — see below.)
 *
 * 🔴 THE INVARIANT, AND IT IS THE WHOLE FILE NOW: **THE APP HOST BOX DECLARES NO WIDTH
 * BOUND, IN ANY SPELLING, ON EITHER ELEMENT.** Not a `max-width`, not a
 * `max-inline-size`, not a Mantine width style prop, not a Tailwind utility, not a
 * substituted root component that carries a measure of its own, and not a bare
 * `max-width` rule in `globals.css` aimed at the host's markers. A full-page App Block
 * gets the viewport; an app that wants a centred column sets one inside its own iframe
 * document.
 *
 * ⚠️ THIS FILE USED TO GUARD A MECHANISM, AND IT NO LONGER HAS ONE TO GUARD — WHICH IS
 * WHY IT DROPPED FROM **10 ARMS TO 3**, AND THAT SHRINKAGE IS THE CORRECTNESS SIGNAL.
 * 🔴 THE ARM COUNT IS THE FIGURE; AN EARLIER VERSION OF THIS SENTENCE SAID "~4x SHORTER"
 * AND NO READING OF THE LINE COUNTS SUPPORTS IT — 1,352 → 711 is 1.9x, and against
 * `main`'s pre-PR 706 this file is 1.007x **LONGER**, because the deleted arms' record
 * moved into prose. Retracted rather than recomputed: a multiplier over line counts is the
 * wrong instrument for "it guards less", and this paragraph is the one whose argument IS
 * the number — in a file that elsewhere says a comment which counts is a comment that goes
 * stale, and retracts two prior count errors for exactly this reason. In two stages: a
 * 1600px `--app-page-max-width` default with a per-app CSS ledger apps could OPT OUT of;
 * then the default at `none` with the ledger re-pointed so a rule would CAP one app
 * instead. The second stage's retained lever is now deleted — property, `var()` read,
 * `margin-inline: auto`, ledger, worked template, publisher HOW-TO and every guard whose
 * subject was any of those. The record is the tombstone above `PageBlockHostProps` in
 * `src/components/AppBlocks/PageBlockHost.tsx`.
 *
 * ⚠️ WHAT WAS DELETED FROM HERE, NAMED SO A LATER READER CAN TELL DELETION FROM ROT.
 * Seven `it(...)` blocks, each of whose SUBJECT was the mechanism rather than the
 * requirement: the exactly-one-`--app-page-max-width`-declaration walk; the `var()`
 * fallback agreement (a two-spellings-of-one-default guard with no default left to
 * spell); the per-app ledger MEMBERSHIP enumeration; the verbatim pin of
 * `maxWidth: 'var(…)', marginInline: 'auto'`; the "both ledger attributes are stamped on
 * the host root" pin; the INVARIANT forbidding an inline `--app-page-max-width` (vacuous
 * once nothing reads the property); and the "globals.css still carries a worked per-app
 * template" pin. Two shared modules went with them —
 * `test/ledger-block-ids.ts` (a selector predicate with nothing to predicate over) and
 * `ledgerSelectorSurvivesProdStrip.test.ts`. 🔴 THAT LAST ONE CARRIED A REAL BUG'S
 * GUARD: a ledger rule once shipped keyed on a `data-testid`, which `next.config.mjs`
 * strips in production, so it matched zero elements on civitai.com with every tier
 * green. The hazard is generic to any stylesheet in this repo, not ledger-specific, so
 * deleting a ledger-shaped guard for it is a SCOPE REDUCTION: the honest replacement is
 * a repo-wide check that no selector in any stylesheet depends on a stripped attribute.
 *
 * 🔴 WHAT SURVIVED, AND WHY IT IS THE PART WORTH KEEPING. The mutation-hardening arms
 * from the review rounds that built this file. Of the mutant families those rounds
 * found, exactly ONE was mediated by `--app-page-max-width`; the rest re-cap this
 * surface without ever naming a custom property, so they guard the owner's requirement
 * DIRECTLY and they are now the whole invariant rather than a supplement to it. Each is
 * a route that leaves every other assertion here green and both rendered tiers unmoved:
 *   · a `max-width` / `max-inline-size` in the inline `style` object, in any of the six
 *     legal JS/React spellings (bare, `'quoted'`, `['computed']`, `` [`backtick`] ``,
 *     dashed `'max-width'`, dashed `'max-inline-size'`)
 *   · a Mantine `maw` / `w` STYLE PROP, which merges INTO the inline style and wins
 *   · a Tailwind `max-w-*` / `w-[…]` class
 *   · a `className` this file cannot READ, which would make the class filter above pass
 *     on a capped element
 *   · the component itself no longer being `Box`
 *   · a `component` / `renderRoot` prop, because `Box` is polymorphic so the tag name is
 *     not the rendered component
 * …applied to BOTH the host root and the app's own column, plus the box-model pin and
 * the `globals.css` bare-`max-width` gate below.
 *
 * 🔴 WHY A SOURCE GUARD AS WELL AS A RENDERED ONE. The measurement lives in
 * `PageBlockHostMaxWidth.browser.test.tsx`, which is the only tier that can see a
 * width at all — but the browser `component` project runs in CI as the
 * REPORT-ONLY `preview / component-tests` status. This file is in the node
 * `unit` project, which is report-only on a pull request too (`continue-on-error`)
 * and renders a real verdict on a push to `main` or a `workflow_dispatch`.
 * 🔴 NEITHER TIER BLOCKS A MERGE — `main` requires no status check at all in this
 * repo — so what a source guard buys is a verdict that is honest on `main` and an
 * annotation a reviewer can read, NOT a door that stays shut. The same split, and
 * the same reasoning, as `pageRunScrollContract.test.ts` (whose own header records
 * the measured case where a fully-reverted floor left this node tier 9/9 green and
 * only the browser tier red).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const HOST = path.join(REPO_ROOT, 'src/components/AppBlocks/PageBlockHost.tsx');
const GLOBALS_CSS = path.join(REPO_ROOT, 'src/styles/globals.css');

/**
 * A repo-relative path with forward slashes on every platform — `path.relative`
 * returns the platform separator, so a raw result compares unequal to the
 * `src/...` literals below on Windows and the guard would fail for the platform
 * rather than for the thing it guards.
 */
const repoPath = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join('/');

function read(file: string): string {
  // Prove the path before trusting a "no match": a comparison against an absent
  // operand reports SAME, not MISSING, so a renamed file would otherwise turn
  // every assertion below into a vacuous pass on an empty string.
  expect(fs.existsSync(file), `${repoPath(file)} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/**
 * Strip block + line comments so a rule can never be satisfied by prose ABOUT the rule —
 * every token searched for below is also discussed at length in the comments of the file it
 * is searched for in.
 *
 * 🔴 A CSS-SAFE STRIPPER, AND THE SPLIT FROM THE SHARED `test/strip-comments` IS NARROW BUT
 * REAL. The shared module also removes TRAILING `//` comments, guarded by `[^:]` so
 * `url(https://…)` survives. `//` is not a comment in CSS at all, so that pass can only ever
 * do harm on a `.css` input — while `.ts` and `.tsx`, which the `style={{…}}` containment
 * assertions read, DO have real `//` comments and want exactly that pass. One stripper cannot
 * be right for both, so this helper is the `.css` branch and `stripTsComments` is the
 * TypeScript one.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Collapse whitespace so an assertion pins the EXPRESSION, not its formatting. */
function norm(src: string): string {
  return src.replace(/\s+/g, ' ').trim();
}

/**
 * The two elements this file reasons about, located by PARSING `PageBlockHost.tsx`
 * rather than by searching its text.
 *
 * 🔴 A REAL PARSE, BECAUSE TWO SUCCESSIVE TEXT-BASED VERSIONS WERE EACH DEFEATED BY
 * WHERE THE CHARACTERS FELL — once by JSX ordering `style` before `data-testid`, and
 * once by `lastIndexOf('<', …)` finding a `<` inside the element's own props. Both
 * failures were silent and both left the guard GREEN for the exact mutation it
 * existed to catch. Offsets cannot express "inside"; a tree can. `typescript` is
 * already used this way by several guards in this repo.
 *
 * 🔴 EXACTLY ONE ELEMENT PER TESTID, ASSERTED. An earlier version keyed a `Map` and
 * let a second occurrence overwrite the first, so with two frame/content pairs (a
 * second render branch, a dev-only variant) it graded whichever appeared LAST and
 * said nothing. A guard must fail on ambiguity rather than pick one.
 */
function hostElements(): {
  frame: ts.JsxOpeningLikeElement;
  content: ts.JsxOpeningLikeElement;
} {
  const sf = ts.createSourceFile(HOST, read(HOST), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map<string, ts.JsxOpeningLikeElement[]>();
  const visit = (n: ts.Node) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      for (const a of n.attributes.properties) {
        if (
          ts.isJsxAttribute(a) &&
          a.name.getText() === 'data-testid' &&
          a.initializer &&
          ts.isStringLiteral(a.initializer)
        ) {
          const list = found.get(a.initializer.text) ?? [];
          list.push(n);
          found.set(a.initializer.text, list);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  // Fail on the LOOKUP rather than letting a missing element make every assertion
  // below vacuous — the reassuring-zero shape this file guards against elsewhere.
  const one = (testid: string, absent: string): ts.JsxOpeningLikeElement => {
    const hits = found.get(testid) ?? [];
    expect(
      hits.length,
      hits.length === 0
        ? absent
        : `PageBlockHost.tsx renders ${hits.length} elements carrying \`data-testid="${testid}"\`. This guard cannot know which one ships, so it would be grading an arbitrary occurrence. Give the other one a different testid, or re-point this guard deliberately.`
    ).toBe(1);
    return hits[0];
  };

  return {
    frame: one(
      'app-page-frame',
      'no element in PageBlockHost.tsx carries `data-testid="app-page-frame"`. This guard uses ' +
        'it to locate the host ROOT — one of the two elements the no-width-bound invariant ' +
        'covers, and the one the app chrome lives on. Re-point this guard only if the element ' +
        'was deliberately renamed.'
    ),
    content: one(
      'app-page-content',
      'no element in PageBlockHost.tsx carries `data-testid="app-page-content"`. This is the ' +
        "app's own column — the other element the invariant covers, and the box whose width IS " +
        'the app’s measure. Without it every assertion below would be scoped to the frame alone.'
    ),
  };
}

/**
 * Is `maybeDescendant` inside `ancestor`'s element? Walks real parent links.
 *
 * 🔴 A SELF-CLOSING ANCESTOR HAS NO DESCENDANTS, AND SAYING SO IS NOT DEFENSIVE NOISE.
 * For a `JsxOpeningElement`, `.parent` is its own `JsxElement` — the subtree its
 * children live in, which is what makes the walk below mean "inside". For a
 * `JsxSelfClosingElement` there is no such element, so `.parent` is the ENCLOSING one
 * and the walk would answer TRUE for the ancestor's own SIBLINGS. Measured with a
 * `typescript` probe: frame self-closing + content a sibling under a shared parent
 * returned `true`. `hostElements` deliberately returns either kind, so this branch is
 * reachable.
 */
function isDescendant(
  ancestor: ts.JsxOpeningLikeElement,
  maybeDescendant: ts.JsxOpeningLikeElement
): boolean {
  if (ts.isJsxSelfClosingElement(ancestor)) return false;
  const ancestorElement = ancestor.parent;
  for (let n: ts.Node | undefined = maybeDescendant.parent; n; n = n.parent) {
    if (n === ancestorElement) return true;
  }
  return false;
}

/**
 * The literal text of an element's `style={{…}}` object, or `null` when this guard
 * cannot see the element's style at all.
 *
 * 🔴 `null` IS NOT THE SAME AS `''`, AND CONFLATING THEM SHIPPED THE HEADLINE
 * REGRESSION GREEN. An earlier version returned `''` for "no inline object literal",
 * and the width assertions below are NEGATIVE (`.not.toMatch`) — which an empty string
 * satisfies trivially. Measured: lifting an element's inline style into a `const` in a
 * sibling module and putting a cap back in it, with the exact spelling the pin named,
 * left this file GREEN while the surface was capped again, through an entirely ordinary
 * refactor. A spread `{...{ style: … }}` did the same.
 *
 * So the two cases are distinguishable and the callers must assert on it: a style this
 * helper cannot read is a REASON TO FAIL, never a reason to pass.
 *
 * 🔴 AND THE SAME LESSON APPLIES ONE LEVEL DEEPER — A SPREAD *INSIDE* THE OBJECT LITERAL,
 * WHICH THIS HELPER USED TO RETURN AS ORDINARY TEXT. Measured by a review round: adding
 *
 *     const CAP_STYLE = { maxWidth: 1600, marginInline: 'auto' } as const;
 *     …
 *     width: '100%',
 *     ...CAP_STYLE,
 *
 * to the FRAME's style object left this whole file **3 passed (3)**, byte-identical to
 * baseline, while the app rendered letterboxed at 1600px and centred again — the exact
 * regression this file exists to catch. Only the report-only browser tier saw it
 * (`5 failed | 9 passed`). The attribute-level check above did not fire because a
 * `SpreadAssignment` is not a `JsxSpreadAttribute`, and the width regex did not fire
 * because `...CAP_STYLE` contains no `max-width`. The docblock above claimed
 * `{...capProps}` was covered "on any `JsxSpreadAttribute`", which was true of the
 * attribute form and false of this one.
 *
 * ⚠️ IT CANNOT SIMPLY REJECT EVERY INNER SPREAD: the frame legitimately carries
 * `...(fit === 'fill' ? {…} : {…})`, which is exactly the local idiom that makes the
 * mutant plausible. So the test is READABILITY, the same test as for the attribute — a
 * spread of an inline object literal (or of a conditional whose branches are both object
 * literals) has its contents present in `getText()` and is therefore scanned by every
 * regex below; a spread of an identifier, a call or a property access does not, and is
 * the unreadable case that must fail.
 */
function styleObjectOf(el: ts.JsxOpeningLikeElement): string | null {
  // A spread can carry `style` from anywhere, so its presence means the attribute list
  // is not the whole story and no conclusion may be drawn from it.
  if (el.attributes.properties.some((a) => ts.isJsxSpreadAttribute(a))) return null;
  for (const a of el.attributes.properties) {
    if (ts.isJsxAttribute(a) && a.name.getText() === 'style' && a.initializer) {
      const init = a.initializer;
      if (!ts.isJsxExpression(init) || !init.expression) return null;
      // Only an inline OBJECT LITERAL is readable here. An identifier or a call means
      // the value lives somewhere this guard is not looking.
      if (!ts.isObjectLiteralExpression(init.expression)) return null;
      // …and every inner spread must be readable too, or the literal's text is not the
      // whole declaration set. See the docblock for the measured mutant.
      const spreadIsReadable = (e: ts.Expression): boolean =>
        ts.isObjectLiteralExpression(e) ||
        (ts.isConditionalExpression(e) &&
          spreadIsReadable(e.whenTrue) &&
          spreadIsReadable(e.whenFalse)) ||
        (ts.isParenthesizedExpression(e) && spreadIsReadable(e.expression));
      for (const p of init.expression.properties) {
        if (ts.isSpreadAssignment(p) && !spreadIsReadable(p.expression)) return null;
      }
      return init.expression.getText();
    }
  }
  return null;
}

/**
 * THE FIVE ATTRIBUTE-SHAPED WIDTH ROUTES, AS NAMED PREDICATES OVER ONE ELEMENT.
 *
 * 🔴 THESE EXIST AS FUNCTIONS SO THE ARM'S FOUR `toEqual([])` ZEROS CAN HAVE A POSITIVE
 * CONTROL THAT RUNS THE SAME CODE. Before this, the arm's evidence that its filters could
 * fire at all was a mutation sweep recorded in a commit message — and the browser suite's
 * own header states the principle those zeros were violating: *"a mutation result that
 * lives only in a PR description is not evidence anyone can re-read"*. Worse, two of the
 * four are vacuous in the ordinary sense as well: neither element carries a `className`
 * today, so both class filters return `[]` whatever their regexes say, and a broken regex
 * would be indistinguishable from a clean element. The control below feeds each predicate
 * a synthetic element it MUST flag.
 *
 * Kept as plain functions rather than folded into one "routes" object so each `expect` in
 * the arm keeps its own route-specific message — which is the thing that makes a failure
 * actionable, and is why this file has six separate arms instead of one.
 */
const attrNames = (el: ts.JsxOpeningLikeElement) =>
  el.attributes.properties.filter(ts.isJsxAttribute).map((a) => a.name.getText());
const attrTexts = (el: ts.JsxOpeningLikeElement) =>
  el.attributes.properties.filter(ts.isJsxAttribute).map((a) => norm(a.getText()));

/** Mantine `maw`/`w` style props — merged into inline style, and they WIN over `style`. */
const mantineWidthProps = (el: ts.JsxOpeningLikeElement) =>
  attrNames(el).filter((n) => n === 'maw' || n === 'w');
/** A Tailwind width utility in a readable `className` string literal. */
const tailwindWidthClasses = (el: ts.JsxOpeningLikeElement) =>
  attrTexts(el).filter((a) => /^class(?:Name)?=/.test(a) && /\b(?:max-w-|w-\[)/.test(a));
/** `component` / `renderRoot` — `Box` is polymorphic, so the tag name is not the root. */
const polymorphicRootProps = (el: ts.JsxOpeningLikeElement) =>
  attrNames(el).filter((n) => n === 'component' || n === 'renderRoot');
/** A `className` the token filter above cannot read, which would pass on a capped element. */
const unreadableClassName = (el: ts.JsxOpeningLikeElement) =>
  attrTexts(el).filter((a) => /^class(?:Name)?=/.test(a) && !/^class(?:Name)?=\s*['"]/.test(a));

/** The first JSX opening element in a synthetic TSX snippet — for the controls only. */
function parseOneElement(tsx: string): ts.JsxOpeningLikeElement {
  const sf = ts.createSourceFile(
    'control.tsx',
    tsx,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let found: ts.JsxOpeningLikeElement | undefined;
  const visit = (n: ts.Node) => {
    if (!found && (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n))) found = n;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  expect(found, `control snippet parsed no JSX element: ${tsx}`).toBeDefined();
  return found!;
}

/** `styleObjectOf`, failing loudly when the style is not readable. `who` names the element. */
function readableStyleOf(el: ts.JsxOpeningLikeElement, who: string): string {
  const text = styleObjectOf(el);
  expect(
    text,
    `the \`${who}\` element's \`style\` is no longer FULLY READABLE as an inline object ` +
      'literal. Either the whole value moved to a variable or another module, was computed, or ' +
      'was spread in as an attribute — OR the literal is still here but contains a spread this ' +
      'guard cannot see through (`...SOMETHING`, where SOMETHING is an identifier, a call or a ' +
      'property access rather than an inline object). This guard reads that literal to decide ' +
      'whether a width bound is declared on the element, so in either case it can no longer ' +
      'answer the question it exists to answer — and it must fail rather than pass silently, ' +
      'which is exactly how a re-capped host shipped green TWICE: once with the style lifted ' +
      "into a sibling module, and once with `...CAP_STYLE` added to the frame's own literal. " +
      'Either keep every declaration inline (a spread of an inline object, or of a conditional ' +
      'whose branches are inline objects, is fine and is scanned), or re-point this guard at ' +
      'wherever the value now lives.'
  ).not.toBeNull();
  return text!;
}

describe('the full-page App Block host declares no width bound', () => {
  /**
   * 🔴 THE INVARIANT, ON BOTH ELEMENTS, THROUGH EVERY ROUTE THAT CAN REACH THEM.
   *
   * ⚠️ WHAT CHANGED WHEN THE MECHANISM WENT, BECAUSE THIS TEST IS THE ONE THAT GOT
   * STRONGER RATHER THAN SMALLER. It used to assert a RELATIONSHIP — that the width pair
   * sat on `app-page-content` and NOT on the frame, since a per-app rule set the custom
   * property on the frame and relied on inheritance to reach the column. Two of its arms
   * were therefore asymmetric: the frame had to NOT contain `--app-page-max-width` while
   * the content element had to CONTAIN it, and the six-spelling width regex ran on the
   * frame ALONE. With no mechanism there is no asymmetry to encode: NEITHER element may
   * declare a width bound, so the width regex now runs inside the both-elements loop with
   * everything else, and the two property-mediated arms are gone. That is a simplification
   * AND a widening — the content element was previously exempt from the width regex, which
   * is the element whose bound letterboxes the app.
   *
   * THE DESCENDANT CHECK IS KEPT AND RE-POINTED, AND IT IS AN INVARIANT GUARD. It no
   * longer protects a per-app rule's inheritance path (there is no rule). What it pins is
   * that the two elements the arms cover really are ONE BOX — host root with the app's
   * column inside it — so "no width bound on either" describes the whole chain rather than
   * two unrelated elements that happen to carry those testids. Measured on the version that
   * compared TEXT OFFSETS instead of the parse tree: closing the frame before the content
   * box, so the two are genuine SIBLINGS, left this file green AND the whole node suite
   * (1569 files / 24,879 tests) byte-identically green.
   */
  it('declares no width bound on either element, in any spelling — style, style prop, class, or component', () => {
    const { frame, content } = hostElements();

    expect(
      isDescendant(frame, content),
      '`app-page-content` is no longer a DESCENDANT of `app-page-frame`. This guard asserts ' +
        '"no width bound on the app host box" by checking two elements, and that phrasing is ' +
        'only truthful while those two elements ARE the box: root, with the app’s own column ' +
        'inside it. Lifted apart — even into a sibling that still renders — the arms below are ' +
        'still green and are describing two unrelated elements. The chrome/app split itself is ' +
        'deliberate (the chrome spans the page like every other site-level bar); this pins that ' +
        'the split is a nesting rather than a separation. This node tier renders nothing, so a ' +
        'source-level containment check is its only view of the relationship; the only tier ' +
        'that can observe it at runtime is the report-only browser tier.'
    ).toBe(true);

    // 🔴 FIVE ROUTES PER ELEMENT, ALL SIX FAMILIES RUN OVER BOTH. Each was found by a review
    // round measuring a mutant that re-capped this surface while leaving every other
    // assertion here green and both rendered tiers unmoved.
    //
    // ⚠️ AND THEY ARE SPREAD-BLIND ON THEIR OWN. `{...capProps}` is caught only because
    // `styleObjectOf` returns `null` on any `JsxSpreadAttribute`, via the `readableStyleOf`
    // call at the top of each iteration. That is inherited safety, not local safety: relax or
    // re-point the style read and the attribute arms for that element lose it silently.
    for (const [testid, element] of [
      ['app-page-frame', frame],
      ['app-page-content', content],
    ] as const) {
      // 🔴 WHAT A BOUND ON EACH ELEMENT WOULD DO. Both are now UNOPPOSED — neither declares a
      // `max-width` of its own any more, so there is nothing for a mutant to lose a specificity
      // contest against. ⚠️ THAT IS A CHANGE FROM THE PREVIOUS VERSION OF THIS MESSAGE, which
      // explained at length that on the content element a STYLE PROP would "override
      // `--app-page-max-width` outright" while a CLASS-borne width would "LOSE to that inline
      // `maxWidth`". Both halves of that reasoning depended on the content element declaring an
      // inline `maxWidth`, and it no longer does — so a Tailwind `max-w-*` class on the content
      // element now really does cap the app column, where before it was inert there. The arms
      // did not change; what they catch got slightly worse, and the message has to say so.
      // (Verified: `tailwind.config.js` sets no `important` and no `prefix`, so Tailwind
      // utilities are ordinary author declarations here — had `important: true` been set, this
      // would invert in the dangerous direction.)
      const where =
        testid === 'app-page-content'
          ? 'THIS element is the APP’S OWN COLUMN, so a bound here letterboxes the third-party ' +
            'app itself — the exact regression this change exists to remove. Nothing else ' +
            'declares a width on it, so any of these is unopposed. '
          : 'THIS element is the host ROOT, so a bound here bounds the app CHROME as well as ' +
            'the app, which is the regression the frame/content split exists to prevent. ' +
            'Nothing else declares a width on it, so any of these is unopposed. ';

      // 🔴 NO `max-width` OR `max-inline-size` IN THE INLINE STYLE, IN ANY SPELLING — AND THE
      // SPELLINGS TOOK FOUR ROUNDS, WHICH IS THE REUSABLE PART. The first version was
      // `/(?:^|[,{\s])maxWidth\s*:/` under a comment already promising "however it is spelled".
      // Five legal respellings walked it, all measured: `'maxWidth':` (prettier rewrites this
      // one back to the caught form, so it self-heals), `['maxWidth']:` (a computed key,
      // semantically identical, prettier KEEPS it), `` [`maxWidth`]: `` (backtick computed key,
      // also preserved), `'max-width':` — which caps in production because react-dom's
      // `setValueForStyles` assigns `style[key] = value` for every non-`--` key and CSSOM
      // exposes the dashed attribute, with only a DEV warning — and `maxInlineSize` /
      // `'max-inline-size'`, the logical equivalent with the same effect. ⚠️ A count of which
      // forms prettier preserves sat here and went stale twice; the regex covers all six in
      // every quoting and computed-key form, so do not re-derive a count. `maxWidthSomething:`
      // and `minWidth:` stay clean, and `width: '100%'` — which both elements legitimately
      // declare — is deliberately NOT matched.
      //
      // ⚠️ IT DOES FIRE ON `maxWidth: 'none'`, which caps nothing. Accepted: neither element has
      // any business declaring a max-width at all, and a value allowlist is the kind of
      // narrowing that re-opens the hole.
      //
      // 🔴 COMMENTS STRIPPED FIRST, WITH `stripTsComments` RATHER THAN THE LOCAL `code()`. The
      // frame's `style={{…}}` carries long inline prose about widths, and `styleObjectOf`
      // returns the literal's raw text, comments included — so the un-stripped form failed this
      // assertion on a comment. `code()` only strips a `//` that STARTS a line, so a trailing
      // `// … max-width …` would survive it and fail on prose all over again. This input is pure
      // TypeScript, so the shared stripper is the right one here in a way it is not for CSS.
      expect(
        stripTsComments(readableStyleOf(element, testid)),
        `\`${testid}\` now declares a \`max-width\` (or \`max-inline-size\`) in its inline ` +
          `style, in some spelling. ` +
          where +
          'The platform imposes no width on a full-page App Block: if a measure is wanted, it ' +
          "belongs inside the app's own document, which the app controls. There is no platform " +
          'lever to express it with — the custom property, the per-app CSS rule and the ledger ' +
          'that held them were all deleted. ' +
          "(`width: '100%'` is legitimate and is NOT what this matches. `maxWidth: 'none'` IS " +
          'matched even though it caps nothing — remove it anyway; the element declaring a ' +
          'max-width at all is the thing being pinned.)'
      ).not.toMatch(/(?:^|[,{[\s])['"`]?max-?(?:width|inline-?size)['"`]?\s*\]?\s*:/i);

      // 🔴 AND A `width` DECLARATION, IF PRESENT, MUST BE EXACTLY `'100%'` — WHICH IS WHAT MAKES
      // THIS ARM'S TITLE TRUE. The regex above matches `max-width`/`max-inline-size` only, and
      // deliberately so: `width: '100%'` is legitimate on both elements and a pattern that caught
      // it would fire on correct code. But the arm's title claims "no width bound … in any
      // spelling", and a HARD width is a bound. Measured by a review round: changing the frame's
      // `width: '100%'` to `width: '1600px'` left this file **3 passed (3)** while the browser
      // tier went **12 failed | 2 passed** — it fails even the below-1600 reference arms, i.e. it
      // is a WORSE regression than the 1600px cap this change removed, and the node tier could
      // not see it. The content element was incidentally protected by its verbatim box-model pin;
      // the frame had nothing.
      //
      // ⚠️ A VALUE PIN, NOT AN ABSENCE PIN, AND THAT IS THE NARROWEST HONEST FORM. Absence would
      // be wrong (both elements must fill their parent, so both SHOULD declare `width`), and a
      // "not a px value" pattern would have to enumerate units. `'100%'` is the one value that
      // means "be my parent's measure", so pinning it says exactly what the requirement says.
      // A deliberate change to e.g. `'100dvw'` has to come here and argue.
      const widthDecl =
        /(?:^|[,{[\s])['"`]?width['"`]?\s*\]?\s*:\s*([^,}\n]+)/i.exec(
          stripTsComments(readableStyleOf(element, testid))
        ) ?? null;
      expect(
        widthDecl === null ? "'100%'" : widthDecl[1].trim().replace(/,$/, ''),
        `\`${testid}\` declares a \`width\` other than \`'100%'\`. ` +
          where +
          'A hard width is a width BOUND, and it is not matched by the `max-width` regex above ' +
          '(which must let `width: 100%` through, since both elements legitimately declare it). ' +
          'This is the assertion that makes this arm\'s title — "no width bound … in any ' +
          'spelling" — a true sentence rather than a claim about `max-width` alone. Measured: a ' +
          "frame `width: '1600px'` fails 12 of the 14 browser arms, INCLUDING the below-1600 " +
          'reference arms, so it is worse than the cap this change removed. If the app column ' +
          "should stop being its parent's measure, that is a deliberate change: make it here."
      ).toBe("'100%'");

      // 🔴 AND NO MANTINE WIDTH STYLE PROP. THIS IS THE CHEAPEST ROUTE OF ALL AND IT SURVIVED
      // THE ROUND THAT CLOSED THE INLINE ONE, because neither element is a `div` — both are
      // `<Box>` from `@mantine/core`, and Mantine's style props are not decoration.
      // `style-props-data.mjs` maps `maw → maxWidth`, `w → width`, `miw → minWidth`, and
      // `get-box-style.mjs` returns `{ ..._style, ..._vars, ...styleProps }` — i.e. a style prop
      // is merged into the element's INLINE STYLE and WINS over the explicit `style` prop. So
      // `maw={1600}` is a real max-width in production, unconditionally, and it touches neither
      // the `style` object nor any class, so every other arm is blind to it.
      //
      // 🔴 `w` IS INCLUDED, `miw` IS NOT, AND THE ASYMMETRY IS THE POINT. `w={1600}` hard-sets
      // `width` past each box's own `width: '100%'` by that same precedence, so it caps. `miw`
      // sets a MINIMUM: it cannot cap, only force overflow — a different defect, and pinning it
      // here would widen the claim past what the message can honestly say. Those three are the
      // COMPLETE width-touching set: of Mantine's style props, exactly `w`/`miw`/`maw` map to a
      // width property.
      //
      // ⚠️ TWO THINGS THIS ARM DOES NOT CLAIM. (a) It over-fires on values that cap nothing —
      // `w="100%"` is semantically identical to the `width: '100%'` both boxes already declare;
      // that fails RED, the safe direction, but the message's advice does not apply to it.
      // (b) `maw={1600}` resolves through Mantine's `spacingResolver` to
      // `calc(100rem * var(--mantine-scale))`, not `1600px` — root-font-size and scale
      // dependent, so the mechanism is unaffected but the arithmetic is not exact.
      // ⚠️ AND A RETRACTION KEPT BECAUSE IT WAS REASSURING IN THE WRONG DIRECTION: an earlier
      // note named `maw={{ base: 1600 }}` as a form that LOSES to inline style. Measured by
      // calling `parseStyleProps` directly, `hasResponsiveStyles` is FALSE when `base` is the
      // only key, so that value merges last and WINS exactly like the plain number. The
      // class-rule form needs at least one non-`base` breakpoint. This arm fires on the
      // attribute NAME, so it catches every form regardless.
      //
      // ⚠️ PLAUSIBLE, NOT THEORETICAL: the exact mutant exists verbatim nearby —
      // `<Box maw={1000} mx="auto">` in `src/components/Collections/CollectionsLanding.tsx`, and
      // `<Box maw={appsMeasureCss(measure)}>` in `src/components/Apps/AppsPageLayout.tsx`, i.e.
      // in the Apps neighbourhood itself.
      expect(
        mantineWidthProps(element),
        `\`${testid}\` now carries a Mantine width style prop (\`maw\` / \`w\`). ` +
          where +
          '`<Box>` merges style props into the element’s INLINE STYLE and they WIN over the ' +
          '`style` prop, so this is a real `max-width` / `width` in production — and it is in ' +
          'neither the `style` object nor a class, so every other assertion here is blind to ' +
          'it. (`miw` is deliberately NOT pinned — a minimum cannot cap, only force overflow. ' +
          '`w="100%"` caps nothing either and still fails here; remove it rather than relaxing ' +
          'this.)'
      ).toEqual([]);

      // 🔴 AND NO TAILWIND WIDTH UTILITY. Tailwind is configured, `max-w-` appears throughout
      // `src/components/**/*.tsx` (measured at one commit as 114 occurrences there against 136
      // for `maw=` — figures that rot, so the invocation is what is worth recording:
      // `git grep -oh <pat> -- 'src/components/**/*.tsx'`), and neither element carries a
      // `className` today, so `className="max-w-[1600px] mx-auto"` is a route someone re-capping
      // this would plausibly reach for. EVERY other guard is blind to it: the style assertions
      // read the `style` object, the globals.css gate's corpus is that one file, and the browser
      // harness loads no Tailwind, so the class resolves to nothing there.
      expect(
        tailwindWidthClasses(element),
        `\`${testid}\` now carries a Tailwind width utility (\`max-w-*\` / \`w-[…]\`). ` +
          where +
          'It is invisible to every other guard here AND to the browser tier, whose harness ' +
          'loads no Tailwind. (`min-w-[…]` and `max-w-none` cap nothing and still fail here; ' +
          'remove them rather than relaxing this.)'
      ).toEqual([]);

      // 🔴 AND THE COMPONENT ITSELF MUST STILL BE `Box`, WHICH IS A CHEAPER RE-CAP THAN ANY OF
      // THE ROUTES ABOVE AND SURVIVED THE ROUND THAT CLOSED THEM. Swapping `<Box>` for
      // `<Container>` — three lines: add `Container` to the existing `@mantine/core` import and
      // rename the open and close tags — caps this element at Mantine's `--container-size-md`,
      // i.e. **960px**, via `max-width: var(--container-size)` plus `margin-inline: auto` in
      // `@mantine/core/styles.layer.css`, which `src/pages/_app.tsx` imports. Nothing else
      // declares a `max-width` on either element, so it is unopposed — a TIGHTER letterbox than
      // the 1600px this change removed, shipped by a rename.
      //
      // 🔴 AND IT IS INVISIBLE TO EVERY OTHER ARM AND TO BOTH TIERS. Measured: the mutation
      // leaves `isDescendant`, `readableStyleOf`, the style check and all four attribute arms
      // byte-identical to baseline, because it adds no attribute and no declaration. And neither
      // the node tier nor the browser tier loads `@mantine/core/styles.css`
      // (`test/component-setup.tsx` extracts only `:root` custom properties), so the Container
      // class is unstyled there and the rendered width stays 100%.
      //
      // ⚠️ THERE IS A THIRD RENDERED TIER AND THAT SENTENCE DOES NOT COVER IT. The `geometry`
      // project's setup (`test/geometry-setup.tsx`) DOES import `@mantine/core/styles.layer.css`
      // and `~/styles/globals.css`, and `PageBlockHostFillHeight.geometry.test.tsx` renders the
      // real host. Checked: it would NOT catch either mutant — it mounts at 390x844 and 390x640,
      // so a 960px Container cap and a `max-w-[1600px]` class are both inert at that width, and
      // every assertion there is height/flex-axis based.
      //
      // ⚠️ PLAUSIBLE, NOT THEORETICAL: `<Container` appears throughout `src/**/*.tsx`, including
      // in `src/components/Apps/AppsPageLayout.tsx` — the same file the Mantine note above cites
      // as "the Apps neighbourhood itself".
      //
      // ⚠️ AN ALLOWLIST, AND DELIBERATELY A ONE-ITEM ONE — BUT NOT FOR THE REASON THIS COMMENT
      // FIRST GAVE. It claimed "`Container`, `Paper`, `Card` and `AppShell.Main` all carry their
      // own measures", and that is FALSE for three of the four: measured against
      // `@mantine/core/styles.layer.css`, only `Container`'s root class declares anything
      // width-related (`max-width: var(--container-size)`, `padding-inline`,
      // `margin-inline: auto`). `Paper` (`.m_1b7284a3`) and `Card` (`.m_e615b15f`) declare none,
      // and `AppShell.Main` (`.m_8983817`) declares only paddings and `min-height`. The error ran
      // in the safe direction — it over-stated the hazard to justify a stricter guard — but it is
      // the sentence carrying the rationale, and an editor wanting `<Paper>` for visual chrome
      // was being told, wrongly, that the swap letterboxes the app.
      //
      // The allowlist survives on the honest ground instead: ANY component can declare a width
      // in its own CSS, the set is open across Mantine versions and app-local wrappers, and a
      // denylist is therefore the losing side of that race. `Box` is the only component either of
      // these elements has any business being, so the pin is "it is still Box" and a deliberate
      // change has to come here and argue. ⚠️ This says nothing about a `div` — a plain `<div>`
      // would also be fine and would fail this arm; that is the accepted cost of an allowlist
      // over a denylist. Same for `<Container fluid>`, which is width-neutral and still blocked.
      expect(
        element.tagName.getText(),
        `\`${testid}\` is no longer a Mantine \`Box\`. Several Mantine components carry their own ` +
          'width measure — `Container` caps at `--container-size-md` (960px) via ' +
          '`@mantine/core/styles.layer.css`, which `src/pages/_app.tsx` imports — so a component ' +
          'swap can letterbox this element more tightly than the 1600px cap this change removed, ' +
          'while adding no attribute and no declaration. That makes it invisible to every other ' +
          'assertion here AND to the browser tier, whose harness does not load the Mantine ' +
          'stylesheet. If the component must change, verify the new one imposes no width and ' +
          're-point this pin in the same commit.'
      ).toBe('Box');

      // 🔴 AND NO `component` OR `renderRoot` PROP, BECAUSE `Box` IS POLYMORPHIC AND THE TAG NAME
      // IS THEREFORE NOT THE RENDERED COMPONENT. Mantine builds `Box` with
      // `createPolymorphicComponent`, and `Box.mjs` decides the root on ONE line:
      // `typeof renderRoot === 'function' ? renderRoot(props) : jsx(Element, { ...props })` — so
      // BOTH props substitute it. `<Box component={Container} …>` and
      // `<Box renderRoot={(p) => <Container {...p} />} …>` each render a `Container`, which
      // applies its own root class unconditionally: the same 960px letterbox the arm above exists
      // to stop, reached by ONE ATTRIBUTE instead of a three-line rename. Measured: either mutant
      // leaves `tagName` as `Box` and passes every other arm — neither name is in the `maw`/`w`
      // set, neither is a `className`, and the `style` object is untouched.
      //
      // 🔴 `renderRoot` IS PINNED BECAUSE IT IS THE ROUTE THIS REPO PREFERS, WHICH MADE IT THE
      // WORSE OMISSION. A first version filtered `component` alone, and a review measured
      // `renderRoot={(p) => <Container {...p} />}` surviving every arm on both elements.
      // ⚠️ AND THE JUSTIFICATION FOR WIDENING IT WAS ITSELF OVERSTATED, WHICH IS WORTH MORE THAN
      // THE ARITHMETIC. It read "live local idiom (12 occurrences across 3 files)". The 12 is
      // textually right and characterises them wrongly: enumerated, there is exactly ONE real
      // `renderRoot={` PROP USAGE in `src/` — `src/components/Apps/RecentlyOpenedApps.tsx` —
      // while five more occurrences in that file and two in its browser test are COMMENT PROSE
      // about it, and the remaining four are `const renderRoot = async () => {…}`, an unrelated
      // local helper in `src/components/Sticker/__tests__/`, i.e. a pure name collision. The pin
      // survives on the honest ground and reads stronger: the ONE usage in `src/` is in the Apps
      // neighbourhood this comment's plausibility argument already cites, and that call site's
      // own comment states the preference outright.
      //
      // ⚠️ AND `renderRoot` IS NOT A `BoxProps` MEMBER, which this comment previously claimed. It
      // comes from `PolymorphicComponentProps` in
      // `node_modules/@mantine/core/lib/core/factory/create-polymorphic-component.d.ts`, a union
      // whose `(props: Record<string, any>) => any` branch — the one usually quoted — is the
      // branch that REQUIRES a `component` prop. The branch that applies to
      // `<Box renderRoot={…}>` with no `component` is `renderRoot?: (props: any) => any`. Wrong
      // owner, wrong branch, and the conclusion ("nothing upstream stops it") holds MORE strongly
      // under the correct one — but a reader grepping `BoxProps` to check it could not reproduce.
      //
      // ⚠️ A `component` prop is not inherently a cap — `component="section"` imposes nothing. It
      // is pinned anyway for the allowlist reason above: whether the substituted component
      // declares a width is not knowable from here, and both elements carry only `style` +
      // `data-*` today, so this is a true and currently-satisfied constraint rather than a
      // speculative one. (An `import { Container as Box }` alias also walks the pair of arms;
      // that is adversarial disguise rather than a plausible re-cap, and is deliberately not
      // chased.)
      expect(
        polymorphicRootProps(element),
        `\`${testid}\` now carries a \`component\` or \`renderRoot\` prop. Mantine's \`Box\` is ` +
          'POLYMORPHIC and decides its root from either one, so the JSX tag name no longer tells ' +
          'you what renders — both `component={Container}` and ' +
          '`renderRoot={(p) => <Container {...p} />}` render a `Container`, which applies its own ' +
          '`max-width: var(--container-size)` (960px) + auto margins from ' +
          '`@mantine/core/styles.layer.css`. ' +
          where +
          'It is invisible to every other assertion here (neither name is a width style prop or ' +
          'a className, and neither touches the `style` object) and to both rendered tiers. If a ' +
          'substituted root is genuinely needed, confirm it declares no width and re-point this ' +
          'arm in the same commit.'
      ).toEqual([]);

      // 🔴 AND THE CLASS VALUE MUST BE READABLE AT ALL — the null-vs-empty-string lesson
      // `styleObjectOf` records, one attribute over. The token filter above scans the attribute's
      // TEXT, so `className={FRAME_CLASS}` (or `{cx(styles.frame)}`, or a `clsx` call over a
      // module constant) contains no literal `max-w-`, the filter returns `[]`, and that arm is
      // GREEN while the element is capped. An unreadable value must FAIL, never pass.
      expect(
        unreadableClassName(element),
        `\`${testid}\`'s \`className\` is not a plain string literal, so the width-utility ` +
          'filter above cannot read it and would pass on a capped element. Either inline the ' +
          'classes as a literal, or re-point these assertions at wherever the value now lives — ' +
          'an unreadable value must be a reason to FAIL, never a reason to pass.'
      ).toEqual([]);
    }
  });

  /**
   * 🔴 POSITIVE CONTROL FOR THE ARM ABOVE — CAN EACH OF ITS PREDICATES FIRE AT ALL?
   *
   * The arm reports five ZEROS (`toEqual([])` ×4, plus a readability `null` check), and a
   * zero from a predicate that can never match is indistinguishable from a clean element.
   * Until this test existed, the only evidence those predicates worked was a mutation sweep
   * recorded outside the tree — which the sibling browser suite's own header names as
   * insufficient: *"a mutation result that lives only in a PR description is not evidence
   * anyone can re-read"*.
   *
   * 🔴 TWO OF THEM WERE VACUOUS IN THE ORDINARY SENSE TOO, WHICH IS THE SHARPER REASON.
   * Neither host element carries a `className` at all, so BOTH class-shaped filters return
   * `[]` whatever their regexes say — a typo in either one would have been invisible. The
   * same holds for `component`/`renderRoot`, which neither element carries.
   *
   * ⚠️ SYNTHETIC INPUTS, RUN THROUGH THE EXACT SAME FUNCTIONS the arm calls — not a second
   * implementation of the same idea. A control that re-spells the predicate it is
   * controlling tests the spelling, not the predicate. That is why those five live as named
   * functions above rather than inline in the arm.
   *
   * ⚠️ THIS IS A CONTROL, NOT COVERAGE. It says the instruments can move; it says nothing
   * about the host. The arm above is what reads the host.
   */
  it('POSITIVE CONTROL — every predicate the invariant arm reports a zero for can fire', () => {
    const maw = parseOneElement(`<Box maw={1600} style={{ width: '100%' }} />;`);
    expect(mantineWidthProps(maw), 'the `maw`/`w` predicate missed `maw={1600}`').toEqual(['maw']);
    expect(
      mantineWidthProps(parseOneElement(`<Box w={1600} />;`)),
      'the `maw`/`w` predicate missed `w={1600}`'
    ).toEqual(['w']);
    // `miw` is deliberately NOT in the set — a minimum cannot cap. Controlling the
    // EXCLUSION too, so a widened predicate is a deliberate edit rather than a drift.
    expect(
      mantineWidthProps(parseOneElement(`<Box miw={1600} />;`)),
      '`miw` is now matched. It sets a MINIMUM, which cannot cap — only force overflow. If ' +
        "that is wanted, widen the arm's message in the same commit; the message currently " +
        'says `miw` is deliberately not pinned.'
    ).toEqual([]);

    expect(
      tailwindWidthClasses(parseOneElement(`<Box className="max-w-[1600px] mx-auto" />;`)),
      'the Tailwind predicate missed `max-w-[1600px]`'
    ).toEqual(['className="max-w-[1600px] mx-auto"']);
    expect(
      tailwindWidthClasses(parseOneElement(`<Box className="flex flex-col" />;`)),
      'the Tailwind predicate flagged a className with no width utility in it — it would ' +
        'false-fire on ordinary classes.'
    ).toEqual([]);

    expect(
      polymorphicRootProps(parseOneElement(`<Box component={Container} />;`)),
      'the polymorphic-root predicate missed `component={…}`'
    ).toEqual(['component']);
    expect(
      polymorphicRootProps(parseOneElement(`<Box renderRoot={(p) => <Container {...p} />} />;`)),
      'the polymorphic-root predicate missed `renderRoot={…}` — the route this repo PREFERS, ' +
        'and the one a first version of the arm left open.'
    ).toEqual(['renderRoot']);

    expect(
      unreadableClassName(parseOneElement(`<Box className={CAP_CLASS} />;`)),
      'the unreadable-className predicate missed `className={IDENT}`, so a capped element ' +
        'whose classes live in a constant would pass the Tailwind filter silently.'
    ).toEqual(['className={CAP_CLASS}']);
    expect(
      unreadableClassName(parseOneElement(`<Box className="max-w-[1600px]" />;`)),
      'the unreadable-className predicate flagged a plain string literal, which IS readable — ' +
        'it would fire on every element carrying ordinary classes.'
    ).toEqual([]);

    // 🔴 AND THE READABILITY CHECK ITSELF, INCLUDING THE INNER-SPREAD CASE A REVIEW ROUND
    // MEASURED AS A SURVIVING MUTANT: `...CAP_STYLE` inside the literal left this whole file
    // green while the app was letterboxed at 1600px and centred. `null` is the "cannot read"
    // signal every caller turns into a failure.
    expect(
      styleObjectOf(parseOneElement(`<Box style={{ width: '100%', ...CAP_STYLE }} />;`)),
      'an UNREADABLE inner spread (`...IDENT`) is being returned as readable text. Its ' +
        'contents are not in the literal, so every width regex below scans a string that ' +
        'cannot contain the cap — the measured mutant that left this file 3/3 green while the ' +
        'host was re-capped.'
    ).toBeNull();
    expect(
      styleObjectOf(parseOneElement(`<Box style={{ width: '100%', ...OUTER }} {...spread} />;`)),
      'a `JsxSpreadAttribute` on the element is being returned as readable.'
    ).toBeNull();
    expect(
      styleObjectOf(
        parseOneElement(`<Box style={{ ...(f ? { flex: 1 } : { height: '100%' }) }} />;`)
      ),
      'a READABLE inner spread — a conditional whose branches are inline object literals — is ' +
        "being rejected. That is the frame's own legitimate idiom " +
        "(`...(fit === 'fill' ? {…} : {…})`), so rejecting it would fail the arm on correct " +
        'code; its contents ARE in the literal text and are scanned.'
    ).not.toBeNull();
  });

  /**
   * 🔴 `flex: 1` ON THE CONTENT WRAPPER IS LOAD-BEARING AND NOTHING RENDERED CATCHES
   * ITS LOSS — which is why this pins the whole style object rather than one token.
   *
   * Measured by mutation, in a copy: deleting `flex: 1` left the FULL node suite
   * (24,879 tests) AND the full `AppBlocks` browser tier (40 files / 484 tests)
   * green, while the app column and its iframe collapsed to a sliver of their
   * height. A running App Block reduced to a strip.
   *
   * 🔴 BUT "THE ONLY THING STANDING BETWEEN THAT MUTATION AND PRODUCTION" IS RETRACTED —
   * THERE IS A RENDERED GUARD, AND IT IS THE `geometry` TIER. This paragraph said that,
   * and `PageBlockHost.tsx`'s own `flex: 1` comment still does (left verbatim there
   * deliberately: `PageBlockHostFillHeight.geometry.test.tsx` BLOCK-QUOTES it, so editing
   * the sentence would rot the quotation — a ⚠️ retraction is appended beside it instead).
   * That geometry file was written for this exact mutation and states at its own
   * "WHAT THIS DOES AND DOES NOT ADD" heading: *"drop `flex: 1` from `app-page-content` →
   * this file fails with the column at 150px of an 844px frame"*. So the mutation is
   * caught in TWO places, and the tier enumeration in the sentence above — node + the
   * `AppBlocks` browser project — is the same omission arm 1 already carves out ("THERE IS
   * A THIRD RENDERED TIER"); it was corrected there and not here, 100 lines apart in one
   * file.
   *
   * What survives, and is the actual reason this pin is whole-object rather than a `flex`
   * presence check: the two guards see different things. This one is a claim about the
   * TEXT of one file and catches the mutation the moment the text changes, on `main`,
   * where the browser tiers are report-only. The geometry file asserts the CONSEQUENCE and
   * catches collapses this pin structurally cannot — a parent losing its height, a
   * `min-height` arriving from the cascade, an ancestor turning `display: block`. Neither
   * replaces the other; the false part was only ever the word "only".
   *
   * 🔴 THE EXPECTED VALUE IS COMPARED AGAINST THE PARSED `style` ATTRIBUTE, AND THE
   * PIN CONTAINS NO ANCHOR REGEX — that is a correctness property, not tidiness.
   * When the same claim was written as `region(src, /…flex: 1,…/)`, `flex: 1` sat
   * inside the ANCHOR: deleting it failed with *"the anchor rotted — update the pin
   * deliberately rather than deleting it"*, so the carefully-written message
   * explaining what `flex: 1` does was unreachable for the one mutation it was
   * written for, and the advice a developer actually saw told them to edit the pin —
   * after which the sliver ships. Worse, deleting `minHeight: 0` (which the
   * component's own comment says is NOT load-bearing) failed WITH the `flex: 1`
   * message. Both mutants died, both for the wrong reason. Anchoring on the element
   * instead means every mutation inside this block fails the equality below and
   * prints the same, correct explanation.
   *
   * ⚠️ THE EXPECTED STRING SHRANK WITH THE MECHANISM, AND IT NOW CARRIES THE
   * NO-WIDTH-BOUND CLAIM AS WELL. It used to end
   * `maxWidth: 'var(--app-page-max-width, none)', marginInline: 'auto',`; both are
   * deleted, so this equality is ALSO a positive statement that the style object
   * contains nothing but the four box-model properties — a second, independent way the
   * `.not.toMatch` arm above would be backed up if it were ever relaxed. `minHeight: 0`
   * is defence rather than load-bearing (see the component's own comment), and
   * `width: '100%'` is what makes the app the parent's measure.
   *
   * Pinned WHOLE, for the reason the deleted width pin recorded: a presence check on
   * `flex` survives `flex: 0`. The accepted cost is that a deliberate reformat of this
   * block fails this test — pay it, and update the string in the same commit.
   */
  it("pins the content wrapper's box model — a dropped `flex: 1` collapses the app with every suite green", () => {
    const { content } = hostElements();
    // 🔴 COMMENTS STRIPPED FIRST, FOR THE SAME REASON AS THE ASSERTIONS ABOVE AND TO REMOVE AN
    // ASYMMETRY BETWEEN THEM. Without it the first inline comment added to THIS element's style
    // literal would fail a BOX-MODEL pin with a box-model message ("update the expected string"),
    // reporting a comment edit as a geometry change — the misattribution class this file records
    // twice already. Stripping costs nothing here (the expected string contains no comment) and
    // `flex: 1` is untouched by it, so the mutation this pin exists for still fails the equality.
    expect(
      norm(stripTsComments(readableStyleOf(content, 'app-page-content'))),
      "This is a DELIBERATE verbatim pin of `app-page-content`'s box model. `flex: 1` is " +
        'what makes this box consume the height the chrome left; without it the app column ' +
        'collapses to its content-based minimum and NO rendered test in either tier ' +
        'notices. It is also the positive form of the no-width-bound invariant: these four ' +
        'properties are the WHOLE style object, so any width declaration added here fails this ' +
        'equality as well as the spelling-blind arm above. If you changed this block on ' +
        'purpose, update the expected string here in the same commit.'
    ).toBe("{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%', }");
  });

  /**
   * 🔴 THE CHEAPEST WAY TO REINTRODUCE A CAP NEVER TOUCHES `PageBlockHost.tsx` AT ALL.
   *
   *     [data-app-page-frame] > div { max-width: 1600px; margin-inline: auto; }
   *
   * That re-caps every full-page App Block in production and is invisible to:
   *   · every assertion above, which reads the host's JSX;
   *   · the whole browser tier, because `test/component-setup.tsx` deliberately does not load
   *     the app cascade (it extracts only unconditional `:root` custom properties), so such a
   *     rule is never injected there and no rendered arm can see it.
   *
   * ⚠️ WHY THIS IS GATED AT ALL, since it was first written up as documentation only. That
   * was justified by "zero instances in this file's history", which is the wrong denominator:
   * dropping the default is exactly what makes this the cheap route, so the base rate changed
   * at the same moment the justification was written. The narrow version costs one regex over
   * one file plus its controls, so it is bought rather than argued about.
   *
   * ⚠️ SCOPE, STATED SO THIS IS NOT READ AS MORE THAN IT IS. THE CORPUS IS EXACTLY ONE FILE:
   * `globals.css`. "The host's own markers" is the SELECTOR FILTER applied within that file,
   * not a second corpus — an inline `maxWidth` in the host's own `style={{…}}` is caught by
   * the arms above, NOT here. A cap arriving from a CSS Module, a component stylesheet, or a
   * selector that reaches the host box without naming it is also NOT covered — closing that
   * needs the real cascade loaded in the browser tier, which moves every other suite's
   * geometry. This is the narrow half, deliberately.
   *
   * 🔴 THE NEAR-MISS CONTROL IS GONE, AND ITS ABSENCE IS EVIDENCE RATHER THAN AN OMISSION.
   * This test used to carry a THIRD control asserting that
   * `[data-app-page-frame][data-block-id='x'] { --app-page-max-width: 1100px; }` was NOT
   * flagged — because that was the documented per-app mechanism, and flagging it would have
   * made the ledger's own template an offender. There is no mechanism and no template now, so
   * there is nothing to carve an exception for and the control has no subject. If a future
   * edit finds itself re-adding that control, the mechanism has come back. (The regex's
   * `(?:^|[;\s])` prefix is KEPT: it is what makes this match the CSS `max-width` PROPERTY
   * rather than any custom property whose name happens to end in it, which is correct
   * matching independently of whether such a property exists.)
   */
  it('no bare `max-width` rule in globals.css targets the app host box', () => {
    const css = code(read(GLOBALS_CSS));

    /**
     * A `max-width` declaration inside a rule whose selector names one of the host's markers.
     *
     * 🔴 CASE-INSENSITIVE, BECAUSE CSS IS. Property names and HTML attribute names are both ASCII
     * case-insensitive, so `MAX-WIDTH:` and `[DATA-APP-PAGE-FRAME]` are live caps — measured
     * against the first version of this gate, which was case-sensitive and returned `[]` for
     * `[data-app-page-frame] > div { MAX-WIDTH: 1600px; }`.
     */
    const hostCapRule =
      /([^{}]*(?:data-app-page-frame|data-block-id|app-page-content)[^{}]*)\{([^}]*)\}/gi;
    // 🔴 `max-inline-size` IS MATCHED, AND ITS ABSENCE WAS A ONE-WORD HOLE IN THIS GATE'S OWN
    // STATED INVARIANT. This file's header names `max-inline-size` as part of the requirement,
    // and the inline-style arm above spent a review round adding it — while this regex read
    // `max-width` alone. Measured against the real `offenders()`:
    // `[data-block-id='x']{max-inline-size:1600px}` returned `[]`. It is the logical-property
    // equivalent with identical effect in a horizontal writing mode, so the cheapest route this
    // gate exists to close was open in the spelling the sibling arm had already learned about.
    //
    // ⚠️ A BARE `width:` IS STILL NOT MATCHED HERE, DELIBERATELY, AND THAT IS A NARROWER CLAIM
    // THAN THE INLINE ARM MAKES. On the host's own elements a hard `width` is caught by the value
    // pin in arm 1. In a CASCADE rule it cannot be: `width: 100%` under a marker selector is
    // perfectly ordinary, so catching `width: 1600px` would need a value allowlist — the exact
    // narrowing this file rejects elsewhere for `maxWidth: 'none'`. So this gate covers
    // `max-width`/`max-inline-size` in globals.css and says so, rather than claiming "any width".
    const offenders = (text: string) =>
      [...text.matchAll(hostCapRule)]
        .filter(([, , body]) => /(?:^|[;\s])max-(?:width|inline-size)\s*:/i.test(body))
        .map(([, selector]) => selector.trim());

    // 🔴 POSITIVE CONTROL — this grep reports a ZERO, and a zero from a pattern that can never
    // match is indistinguishable from a clean file. Feed it the exact rule the docblock above
    // names, and separately an upper-case spelling.
    expect(
      offenders(`[data-app-page-frame] > div { max-width: 1600px; margin-inline: auto; }`),
      'POSITIVE CONTROL FAILED: the bare-`max-width` grep did not flag the exact rule this ' +
        'guard exists to catch, so the zero it reports for globals.css carries no information.'
    ).toEqual(['[data-app-page-frame] > div']);
    expect(
      offenders(`[DATA-APP-PAGE-FRAME] > div { MAX-WIDTH: 1600px; }`),
      'POSITIVE CONTROL FAILED ON CASE: the grep missed an upper-case spelling. CSS property ' +
        'names and HTML attribute names are both ASCII case-insensitive, so this is a live cap ' +
        'and not a curiosity — it walked the first version of this gate.'
    ).toEqual(['[DATA-APP-PAGE-FRAME] > div']);
    expect(
      offenders(`[data-block-id='x'] { max-inline-size: 1600px; }`),
      'POSITIVE CONTROL FAILED ON THE LOGICAL PROPERTY: the grep missed `max-inline-size`, ' +
        'which is the same cap in a horizontal writing mode. This exact input returned `[]` ' +
        'against the version of this gate that matched `max-width` alone, while the file header ' +
        'already named `max-inline-size` as part of the invariant.'
    ).toEqual(["[data-block-id='x']"]);

    // 🔴 AND THE CORPUS FILTER'S OWN PREMISE, WHICH NOTHING ELSE PINS SINCE THE LEDGER WENT.
    // `hostCapRule` only looks at rules whose selector names one of three markers, so this
    // gate's `[]` is only meaningful while the host actually STAMPS them. The arm that used to
    // assert that (`stamps BOTH ledger attributes on the host root`) was deleted with the
    // ledger — correctly, since its stated subject was a per-app rule's selector — but it was
    // also the only pin on the attributes, and both now have no other consumer in the repo.
    // Measured: delete `data-app-page-frame` and `data-block-id` from the host and this gate can
    // never return non-zero again, while BOTH synthetic controls above stay green — they
    // validate the regex, not the corpus's relevance. That is the reassuring-zero shape this
    // file guards against everywhere else, reached through the corpus rather than the pattern.
    //
    // ⚠️ THE THIRD MARKER IS A TESTID SPELLING AND IS THE WEAK ONE: `app-page-content` reaches
    // the DOM only as `data-testid`, which `next.config.mjs` strips under
    // `NODE_ENV === 'production'`. So a production rule keyed on it is inert anyway, and this
    // gate's real reach in a shipped build rests on the two attributes below. Re-pointed here,
    // justified by THIS gate rather than by the deleted ledger — if the attributes are removed
    // (the host's own comment calls them deletion candidates), narrow `hostCapRule` in the same
    // commit rather than deleting this.
    const frameAttrs = hostElements()
      .frame.attributes.properties.filter(ts.isJsxAttribute)
      .map((a) => a.name.getText());
    expect(
      ['data-app-page-frame', 'data-block-id'].filter((n) => !frameAttrs.includes(n)),
      'the host root no longer stamps a marker this gate selects on. `hostCapRule` above filters ' +
        'globals.css to rules naming `data-app-page-frame`, `data-block-id` or ' +
        '`app-page-content`; with a marker gone, a rule could never name it, so the `[]` this ' +
        'gate reports would carry no information about the shipped DOM while its synthetic ' +
        'controls stayed green. Either keep the attribute, or narrow `hostCapRule` to the ' +
        'markers that remain — in the same commit, deliberately.'
    ).toEqual([]);

    expect(
      offenders(css),
      'a rule in src/styles/globals.css sets a bare `max-width` or `max-inline-size` on a ' +
        "selector naming the app host's own markers. (READ WHICH: the message named " +
        '`max-width` alone for one revision while the body matched both, so check the reported ' +
        'selector rather than assuming the property.) That caps every full-page App Block ' +
        '(or one of them) without ' +
        'touching `PageBlockHost.tsx`, so it is invisible to every other assertion in this ' +
        'file AND to the entire browser tier, whose harness does not load the app cascade. The ' +
        'platform is meant to impose no width on a full-page App Block at all: there is no ' +
        'sanctioned place for such a rule, and an app that needs a measure sets one inside its ' +
        'own document.'
    ).toEqual([]);
  });
});
