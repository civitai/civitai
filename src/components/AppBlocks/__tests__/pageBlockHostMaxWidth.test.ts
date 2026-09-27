import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
// The ONE spelling of "which app does a `[data-block-id=…]` selector name". This file's
// private copy of that predicate required a quoted value and a bare `=`, and was the only
// intolerant one of four — which made a legal `[data-block-id*='…']` rule a SURVIVING
// MUTANT against the membership enumeration below. See that module for the measured table.
import { blockIdsIn, isLedgerSelector, TEMPLATE_RULE } from '../../../../test/ledger-block-ids';
// The repo's shared TypeScript comment stripper, used ONLY on TS input here — see `code()`
// for why the mixed CSS+TS corpus keeps a narrower local one.
import { stripComments as stripTsComments } from '../../../../test/strip-comments';

/**
 * THE FULL-PAGE APP BLOCK'S WIDTH — the SOURCE half.
 * (`PageBlockHostMaxWidth.browser.test.tsx` is the MEASURED half. Neither half is a
 * merge gate — see below.)
 *
 * 🔴 THE SURFACE IS UNCAPPED, AND THAT IS WHAT THIS FILE NOW PINS. A full-page App
 * Block gets the viewport: `--app-page-max-width` is declared `none` on `:root` in
 * `src/styles/globals.css`, and `PageBlockHost` reads it as
 * `max-width: var(--app-page-max-width, none)` with `margin-inline: auto` on the app's
 * own content wrapper, so both declarations are inert at every width.
 *
 * ⚠️ THIS FILE USED TO GUARD A 1600px CAP AND ITS PER-APP OPT-OUT LEDGER. The cap was
 * dropped by an owner decision; the reasoning, the history and what the 1600 cost are
 * all recorded on the `--app-page-max-width` declaration in `src/styles/globals.css`.
 * Nothing here was deleted for being obsolete — every assertion below is the same claim
 * RE-POINTED at the new default, including the ledger membership (which now expects the
 * EMPTY set and still fails on growth as well as shrink) and the single-source-of-truth
 * pair (which now checks two spellings of `none` agree rather than two spellings of a
 * number).
 *
 * 🔴 THE MECHANISM IS KEPT, POINTING THE OTHER WAY — which is why the structural pins
 * still matter with nothing capped. A CSS rule keyed on
 * `[data-app-page-frame][data-block-id='…']` can still set a width for ONE app; it
 * would now CAP that app rather than excuse it. So the inheritance relationship, the
 * two stamped attributes, and the `var()` read are all still load-bearing, and each
 * still fails silently if broken.
 *
 * 🔴 ON `app-page-content`, NOT ON THE HOST ROOT — the root carries the app CHROME,
 * which spans the page like every other site-level bar, and the value is read one level
 * down on the app's own column. A per-app rule keys on the ROOT and reaches that box by
 * INHERITANCE. That split is why two of the pins below are about the RELATIONSHIP
 * between the two elements rather than about either one alone: before it, the cap and
 * the rule's anchor were the same element and the older pins composed into the
 * mechanism for free. They no longer do.
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
 *
 * WHAT IS PINNED HERE — each is a thing whose absence is SILENT. Deliberately an
 * unnumbered list: it has grown twice, and a count stated beside the thing it counts
 * drifts on the next edit. Read the `it(...)` titles for the authoritative set.
 *   · `--app-page-max-width` is declared exactly ONCE in shipped `src/`, in
 *     globals.css, ON `:root`, and the default it declares is `none` (uncapped)
 *   · the host's `var()` FALLBACK is that same value — the two spellings of one
 *     default, which cannot be bound together by an import in either direction
 *   · the width pair (`max-width` + `margin-inline`), as one verbatim expression
 *   · the value is read on `app-page-content` and that box is INSIDE the frame — the
 *     relationship a per-app rule's inheritance depends on, which no older pin covers
 *   · the content wrapper's whole box model, because a dropped `flex: 1` collapses
 *     the app to a sliver with every test in BOTH tiers green (measured)
 *   · BOTH `data-app-page-frame` and `data-block-id` are stamped on the host root
 *     ELEMENT — a per-app rule's selector chains them, so a rename OR a move of
 *     either half onto another element makes such a rule match nothing without
 *     changing anything visible
 *   · the per-app ledger's MEMBERSHIP, which is the empty set
 *   · the value is read through `var()` and never written inline
 *
 * 🔴 WHAT IS **NOT** PINNED HERE, AND WHY. That a per-app rule's selector survives the
 * PRODUCTION compiler is a different claim, and this file cannot make it: it reads
 * source, not the build config. `next.config.mjs` strips `data-testid` from the DOM
 * under `NODE_ENV === 'production'`, so a rule keyed on the testid ships in the
 * stylesheet and matches nothing live — which is exactly what happened to the old
 * ledger, with this file and the browser suite both green. That seam is owned by
 * `ledgerSelectorSurvivesProdStrip.test.ts`.
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
 * 🔴 A CSS-SAFE STRIPPER, AND THE SPLIT FROM THE SHARED `test/strip-comments` IS NARROWER
 * THAN A FIRST DRAFT OF THIS COMMENT CLAIMED. The shared module also removes TRAILING `//`
 * comments, guarded by `[^:]` so `url(https://…)` survives — so calling it "a TYPESCRIPT
 * stripper" that would break CSS generally was too strong, and a review measured it: the only
 * `//` it eats in CSS is a PROTOCOL-RELATIVE `url(//cdn…)` or a `//` after a non-`:`
 * character, and `src/styles/globals.css` currently contains zero `//` sequences of any kind.
 *
 * What is true, and is why both exist: `//` is not a comment in CSS at all, so the shared
 * pass can only ever do harm on a `.css` input — while `.scss`, `.ts` and `.tsx`, which are
 * also in the declaration walk below, DO have real `//` comments and want exactly that pass.
 * One stripper cannot be right for all four, so the walk picks by EXTENSION (it is already
 * testing the extension to build its file list) and this helper is the `.css` branch plus the
 * CSS reads elsewhere in the file. `stripTsComments` is the TypeScript branch, and it is what
 * the `style={{…}}` containment assertions use, where a trailing comment naming
 * `--app-page-max-width` would otherwise decide the result.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Collapse whitespace so an assertion pins the EXPRESSION, not its formatting. */
function norm(src: string): string {
  return src.replace(/\s+/g, ' ').trim();
}

/**
 * Pull one source region out by anchor regex and fail loudly if the anchor stops
 * matching. An unmatched anchor must never read as "the rule is satisfied", and
 * more than one match means the pin has become ambiguous and is grading an
 * arbitrary occurrence.
 */
function region(src: string, anchor: RegExp, label: string): string {
  const all = [...src.matchAll(new RegExp(anchor.source, `${anchor.flags.replace('g', '')}g`))];
  expect(
    all.length,
    `${label}: expected exactly ONE match for ${anchor}, found ${all.length}. ` +
      'Zero means the anchor rotted — update the pin deliberately rather than deleting it. ' +
      'More than one means this pin is now ambiguous.'
  ).toBe(1);
  return norm(all[0][0]);
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
 * said nothing. That is the property `region()` — the text helper this replaced —
 * had and this one dropped: it fails on ambiguity rather than picking one.
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
        'it to locate the host ROOT and prove the content wrapper is inside it — the relationship ' +
        "a per-app width rule's inheritance depends on. (Such a rule selects on " +
        '`data-app-page-frame`, not on the testid, which production strips.) Re-point this ' +
        'guard only if the element was deliberately renamed.'
    ),
    content: one(
      'app-page-content',
      'no element in PageBlockHost.tsx carries `data-testid="app-page-content"`. If the width ' +
        'declarations moved back onto the host root, the app chrome would be bounded along with ' +
        'the app by any per-app rule — the regression that split these two elements apart.'
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
 * returned `true`, i.e. the guard would certify the ledger's inheritance while it was
 * dead. `hostElements` deliberately returns either kind, so this branch is reachable.
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
 * and the frame-side caller asserts `.not.toContain('--app-page-max-width')` — which
 * an empty string satisfies trivially. Measured: lifting the frame's inline style into
 * a `const` in a sibling module and putting the cap back in it, with the exact pinned
 * spelling, left this file 9/9 GREEN while the app chrome was capped again — the one
 * regression this file exists to catch, through an entirely ordinary refactor. A
 * spread `{...{ style: … }}` did the same.
 *
 * So the two cases are now distinguishable and the callers must assert on it: a style
 * this helper cannot read is a REASON TO FAIL, never a reason to pass.
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
      return ts.isObjectLiteralExpression(init.expression) ? init.expression.getText() : null;
    }
  }
  return null;
}

/** `styleObjectOf`, failing loudly when the style is not readable. `who` names the element. */
function readableStyleOf(el: ts.JsxOpeningLikeElement, who: string): string {
  const text = styleObjectOf(el);
  expect(
    text,
    `the \`${who}\` element's \`style\` is no longer an inline object literal (it was moved to a ` +
      'variable or another module, computed, or spread in). This guard reads that literal to ' +
      'decide WHERE the ultrawide cap is declared, so it can no longer answer the question it ' +
      'exists to answer — and it must fail rather than pass silently, which is exactly how a ' +
      're-capped chrome once shipped 9/9 green. Either keep the style inline, or re-point this ' +
      'guard at wherever it now lives.'
  ).not.toBeNull();
  return text!;
}

/**
 * The host's `var()` FALLBACK for `--app-page-max-width`, read off the parsed
 * `app-page-content` element rather than out of the file's text.
 *
 * 🔴 THIS REPLACED A CONSTANT, AND THE REPLACEMENT IS WHY IT IS A PARSE. The fallback
 * used to be `${APP_PAGE_MAX_WIDTH_PX}px`, so the "two spellings must agree" guard
 * could read an `export const` with a one-line regex. The constant is gone with the cap
 * it named (see the note where it was declared in `PageBlockHost.tsx`), so the fallback
 * is now a literal inside the style object — and the only honest way to find it is the
 * same per-element parse the rest of this file uses. A whole-file regex would also
 * match the property's own name in prose, and `code()` cannot help because the
 * expression is code.
 *
 * `null` when the element's style is unreadable, so the caller can fail rather than
 * pass on an absence — the same distinction `styleObjectOf` records at length.
 */
function hostVarFallback(): string | null {
  const { content } = hostElements();
  const style = styleObjectOf(content);
  if (style === null) return null;
  const m = /maxWidth:\s*'var\(--app-page-max-width,\s*([^)]+)\)'/.exec(style);
  return m ? m[1].trim() : null;
}

describe('the full-page App Block host imposes no width, and one app can still be capped', () => {
  /**
   * 🔴 CSS CANNOT IMPORT A TS VALUE AND TS CANNOT READ A STYLESHEET, so the default
   * exists twice and this is the only thing keeping the two in step. Exactly the
   * arrangement — and the failure mode — that `--header-height` / `HEADER_HEIGHT_PX`
   * has in `pageRunScrollContract.test.ts`.
   *
   * The custom property is the LIVE value; the literal inside the host's `var()` is the
   * fallback. So a divergence is not cosmetic: it means the width the site ships and
   * the width the component claims are different, and the fallback silently takes over
   * anywhere the app stylesheet is not loaded — a moderator preview, a storybook-ish
   * harness, any surface that renders the host without `globals.css`.
   *
   * ⚠️ THE EXPECTED VALUE `none` IS A LITERAL HERE, NOT DERIVED. That is deliberate and
   * it is the whole point of this assertion: a guard that only compared the two
   * spellings to EACH OTHER would stay green on a coordinated edit that re-capped the
   * surface in both places at once, which is exactly the shape a "quick revert" takes.
   * Pinning the literal means re-introducing a cap has to come here and say so.
   */
  it('`--app-page-max-width` is declared once in shipped `src/`, in globals.css, and the default is `none` (uncapped)', () => {
    const SRC = path.join(REPO_ROOT, 'src');
    const files = fs
      .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(css|scss|ts|tsx)$/.test(f))
      .map((f) => path.join(SRC, f))
      // `readdirSync` yields directories too, and this repo has directories whose
      // names end in a matching extension — reading one throws EISDIR.
      .filter((f) => fs.statSync(f).isFile());
    // Guard the walk itself: a glob matching nothing makes everything below
    // vacuously true, which is the reassuring-zero failure mode.
    expect(files.length, 'the src/ walk matched no stylesheets or TS files').toBeGreaterThan(1000);

    const decls: { file: string; value: string; selector: string }[] = [];
    /** Declarations under a `[data-block-id=…]` selector — the platform width-cap ledger. */
    const ledgerOverrides: { file: string; value: string; selector: string }[] = [];
    for (const file of files) {
      // 🔴 TEST FILES ARE OUT OF SCOPE, AND THE CLAIM IS NARROWED TO MATCH —
      // this counts declarations in SHIPPED source, not every occurrence under
      // `src/`. Unlike the `--header-height` guard (which skips only itself),
      // this property's own coverage REQUIRES a test to declare it: the browser
      // suite proves the width is really read from the custom property, and
      // proves a per-app rule's shape works, by injecting overrides of exactly
      // this form. Counting those as duplicates would make the guard forbid its own
      // evidence. A declaration inside a `*.test.*` file cannot reach a user, so
      // excluding them costs nothing the claim above needs.
      if (/\.test\.tsx?$/.test(file)) continue;
      // 🔴 PICK THE STRIPPER BY EXTENSION. `//` is a real comment in `.scss`/`.ts`/`.tsx`
      // and not a comment at all in `.css`, so one pass cannot be correct for this mixed
      // corpus. Under-stripping a `.scss`/`.ts` file counts a commented-out declaration as a
      // real one (a false "the DEFAULT is duplicated" red); over-stripping a `.css` file
      // could eat a protocol-relative `url(//…)` line. See `code()` for the measurements.
      const src = /\.css$/.test(file)
        ? code(fs.readFileSync(file, 'utf8'))
        : stripTsComments(fs.readFileSync(file, 'utf8'));
      // Three spellings, matching the `--header-height` guard: plain CSS, the
      // CSS-in-JS object form (including a computed key), and the imperative
      // setter. The second is the one that would silently defeat a per-app rule.
      const patterns = [
        /--app-page-max-width\s*:\s*([^;}\n]+)/g,
        /['"`]--app-page-max-width['"`]\s*\]?\s*:\s*([^,;}\n]+)/g,
        /setProperty\(\s*['"`]--app-page-max-width['"`]\s*,\s*([^)]+)\)/g,
      ];
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          // 🔴 A LEDGER OVERRIDE IS NOT A DUPLICATE DEFAULT, and an earlier
          // version of this guard could not tell them apart — it counted every
          // declaration and demanded exactly one, so the FIRST real ledger entry
          // would have failed it. That is a guard that forbids the feature it is
          // guarding, and it would have been discovered by whoever added the entry
          // rather than by whoever wrote the guard. The split still matters with
          // the ledger EMPTY: it is what lets a future entry land without this
          // assertion reading it as a second default.
          //
          // The discriminator is the SELECTOR this declaration sits under: read
          // back to the nearest `{`, and the text between the previous `}` (or
          // the start of file) and it is that rule's selector. A ledger entry is
          // keyed on `[data-block-id=…]`; the default is on `:root`. Kept to a
          // slice-and-look rather than a CSS parser deliberately — every
          // declaration of this property lives in one flat, top-level region of
          // globals.css, and the `--header-height` guard's own history records
          // five audit rounds in which each parser added to close a hole shipped
          // a new false PASS. If this property ever gains a declaration nested
          // inside an at-rule, this needs revisiting rather than extending.
          const before = src.slice(0, m.index ?? 0);
          const open = before.lastIndexOf('{');
          const selector = open === -1 ? '' : before.slice(before.lastIndexOf('}', open) + 1, open);
          const entry = {
            file: repoPath(file),
            value: m[1].trim().replace(/^['"`]|['"`]$/g, ''),
            // Kept rather than discarded so the `:root` claim below is checkable — see the
            // assertion that reads it. Normalised only for whitespace; anything else would
            // be this slice deciding what a selector "really" is.
            selector: selector.trim(),
          };
          if (isLedgerSelector(selector)) ledgerOverrides.push(entry);
          else decls.push(entry);
        }
      }
    }

    expect(
      decls.map((d) => `${d.file}: ${d.value}`),
      'expected exactly ONE DEFAULT `--app-page-max-width` declaration in shipped src/ (test ' +
        'files excluded, and `[data-block-id=…]` per-app overrides excluded — those are the ' +
        'platform width-cap ledger and are counted separately below). Zero means it was renamed, ' +
        'removed or commented out — the host then falls back to its inline literal and any ' +
        'per-app rule overrides a property nothing else sets. More than one means the DEFAULT is ' +
        'conditional or duplicated, and calling globals.css the single source of truth is no ' +
        'longer a truthful claim. 🔴 THERE IS A THIRD CAUSE AND IT IS NOT A DUPLICATED DEFAULT: ' +
        'a VALUELESS `[data-block-id]` selector (or an upper-case `[DATA-BLOCK-ID=…]`), which ' +
        'caps EVERY app and is deliberately invisible to `blockIdsIn` — so it lands here rather ' +
        'than in the ledger bucket, and this is the ONLY assertion in the repo that catches it. ' +
        'If the extra declaration is under a `data-block-id` selector, that is what you are ' +
        'looking at; see `test/ledger-block-ids.ts` for the measured table.'
    ).toHaveLength(1);
    expect(decls[0].file, 'the `--app-page-max-width` declaration moved out of globals.css').toBe(
      'src/styles/globals.css'
    );
    expect(
      decls[0].value,
      'the DEFAULT `--app-page-max-width` in globals.css is no longer `none`, i.e. the platform ' +
        'has started imposing a width on every full-page App Block again. That was dropped by an ' +
        'owner decision and the reasoning is recorded on that declaration — if the decision has ' +
        'been re-taken, change this literal in the same commit and say why there. Note the ' +
        'fallback in PageBlockHost.tsx has to move with it (next test), and the boundary the ' +
        'browser suite brackets (1600 inert / 1620 binding) is where a 1600px cap started to ' +
        'bind.'
    ).toBe('none');

    // 🔴 AND IT MUST BE ON `:root`, WHICH THIS GUARD CLAIMED AND DID NOT CHECK. The title,
    // the docblock and the message above all say `:root`; until this assertion existed the
    // body checked count, file and value only, so moving the declaration onto `body`, `html`
    // or any other selector passed. Inert while both spellings are `none` (a declaration
    // anywhere in the ancestor chain inherits the same), and load-bearing again the moment a
    // cap returns — plus the browser harness's own extraction
    // (`test/component-setup.tsx`) requires an unconditional `:root` rule, so without this
    // the two tiers disagreed about what was being guarded. The selector is already computed
    // by the discriminator slice above; it was simply discarded for the non-ledger branch.
    expect(
      decls[0].selector,
      'the DEFAULT `--app-page-max-width` is no longer declared on a bare `:root`. This is a ' +
        'STRICTER pin than the browser harness needs, deliberately: `test/component-setup.tsx` ' +
        'accepts a GROUPED selector (it splits on `,` and takes any part equal to `:root`), so ' +
        '`:root, html { … }` would still be extracted there. ⚠️ An earlier version of this ' +
        'message claimed such a declaration would be "absent from every rendered test", which ' +
        'is false for exactly that form. The real reason to pin the bare form is that it keeps ' +
        "the two tiers' extraction rules from diverging silently — the harness's tolerance is a " +
        'property of the harness, not a contract. If a grouped selector is genuinely wanted, ' +
        'widen this assertion deliberately rather than relaxing it.'
    ).toBe(':root');

    // Every per-app override must live in globals.css beside the default. A rule of
    // this shape in a CSS Module or a component stylesheet would work, but it would
    // put a platform-imposed app width somewhere no one reviewing the ledger looks.
    expect(
      [...new Set(ledgerOverrides.map((d) => d.file))],
      'a `[data-block-id=…]` override of `--app-page-max-width` was found outside globals.css. ' +
        'The platform width-cap ledger is meant to be one reviewable list; an entry elsewhere is ' +
        'invisible to everyone reading it.'
    ).toEqual(ledgerOverrides.length === 0 ? [] : ['src/styles/globals.css']);
  });

  /**
   * 🔴 THE OTHER HALF OF THE SINGLE SOURCE OF TRUTH — THE `var()` FALLBACK, WHICH IS
   * THE VALUE THAT SHIPS WHEREVER `globals.css` IS NOT LOADED.
   *
   * This used to be free: the fallback was `${APP_PAGE_MAX_WIDTH_PX}px`, so the test
   * above could compare a CSS declaration against an `export const` it had already
   * parsed. With the constant gone the fallback is a literal in the style object, and
   * nothing but this assertion binds it to the stylesheet.
   *
   * ⚠️ AND IT IS THE HALF NO RENDERED TEST CAN SEE. The browser tier's component harness
   * DOES extract `:root` custom properties from `globals.css`, so the property is always
   * set there and the fallback branch is never taken — a fallback of `1600px` would
   * leave every measurement in that tier unchanged while capping every host rendered
   * outside the app cascade. Source is the only place this is observable.
   */
  it("the host's `var()` fallback is `none` too — the default cannot differ between the two spellings", () => {
    const fallback = hostVarFallback();
    expect(
      fallback,
      'could not read the `var(--app-page-max-width, …)` fallback off the `app-page-content` ' +
        'element in PageBlockHost.tsx. Either the expression was reformatted past the parse in ' +
        '`hostVarFallback`, or the style stopped being an inline object literal. Re-point the ' +
        'parse — an unreadable fallback must not read as an agreeing one.'
    ).not.toBeNull();
    expect(
      fallback,
      "the host's `var()` fallback for `--app-page-max-width` is not `none`, so a host rendered " +
        'WITHOUT globals.css (a preview surface, a harness) is capped while the site is not. The ' +
        'two spellings of one default have diverged; the stylesheet is the live value and this ' +
        'literal is what ships in its absence.'
    ).toBe('none');
  });

  /**
   * 🔴 THE PER-APP LEDGER IS A MEMBERSHIP LIST, AND BOTH DIRECTIONS ARE STILL THE
   * POINT — THE SET IS JUST EMPTY AND THE DIRECTIONS HAVE SWAPPED MEANING.
   *
   * ⚠️ WHY IT IS EMPTY, STATED HERE RATHER THAN INFERRED FROM THE DIFF. This ledger
   * used to be the ONLY way out of a 1600px default cap, and it had two members. The
   * default is now `none` — the platform imposes no width, by an owner decision
   * recorded on the `--app-page-max-width` declaration in `src/styles/globals.css` —
   * so both rules were setting `none` against a default of `none` and did nothing at
   * all. They were removed as no-ops, NOT because the analysis behind them was wrong;
   * that analysis is preserved in the ledger comment — CONDENSED, not verbatim, and the word
   * "verbatim" is removed here because a review checked it and it was false — because it is what a
   * future cap would have to be wrong about.
   *
   * SO WHAT EACH DIRECTION NOW CATCHES:
   *   · GROWTH — a rule here now CAPS one app rather than excusing it. An entry
   *     appearing without this expectation moving means the platform started
   *     constraining a third-party surface and nobody decided to. That is the
   *     direction that matters today, and it is strictly more important than it was
   *     when growth merely meant "an app got more room".
   *   · SHRINK — vacuous at `[]` and kept anyway, because the assertion is an
   *     ENUMERATION and enumeration is what makes growth detectable. Relaxing this to
   *     a `toContain`, a length check or a superset test would throw the growth half
   *     away too.
   *
   * 🔴 `[]` IS ALSO WHERE THIS EXPECTATION STARTED, AND THAT IS THE PROPERTY WORTH
   * KEEPING: an empty enumeration is what forces the FIRST entry to be argued for
   * rather than appended. The last time the set grew (`sensei`) this assertion went red
   * naming `+ "sensei"` as the delta, and only then was the expectation updated. That
   * is the workflow working; it works identically from `[]`.
   *
   * The ids are read from the SELECTORS, not from a hand-kept list elsewhere, so a rule
   * nobody told this test about is what it notices. `code()` strips comments first, so
   * the `my-canvas-app` template rule inside the ledger's own doc comment is not a
   * member — that template is deliberately NOT a live rule, and this is the assertion
   * that would notice if it ever became one.
   */
  it('the platform width-cap ledger — membership is explicit and EMPTY, and fails on growth AND shrink', () => {
    // 🔴 POSITIVE CONTROL ON THE EXTRACTOR, THROUGH THE SAME PIPELINE THIS TEST USES —
    // `blockIdsIn(code(...))`, not `blockIdsIn(...)` alone. Two reasons it is here rather
    // than trusted. (1) The expectation below is `[]`, so the only direction this assertion
    // is ever exercised in is the one where a missed spelling is a false PASS; a `[]` from a
    // broken extractor is indistinguishable from a `[]` from an empty ledger. (2) The
    // spellings named here are the exact ones that USED to slip through, when this test
    // open-coded `/\[data-block-id\s*=\s*['"]([^'"]+)['"]\]/`: an unquoted value and any
    // operator other than a bare `=` are both legal CSS, and
    // `[data-app-page-frame][data-block-id*='sensei'] { --app-page-max-width: 1100px; }` was
    // therefore a rule that capped an app in production with this file 9/9 green. Controlling
    // the PIPELINE also covers `code()`: if it over-stripped, the probe would come back empty.
    expect(
      blockIdsIn(
        code(
          `[data-app-page-frame][data-block-id='quoted'] {}\n` +
            `[data-app-page-frame][data-block-id=unquoted] {}\n` +
            `[data-app-page-frame][data-block-id*='partial'] {}\n` +
            // The ASCII case-insensitivity flag. This one is here because it ESCAPED the
            // first version of the shared extractor and was measured green across all three
            // guard files — a rule capping an app in production with nothing red.
            `[data-app-page-frame][data-block-id='flagged' i] {}\n` +
            // Legal whitespace inside the bracket. Not a membership hole (the id was still
            // extracted) but it WAS a false-red in the discriminator, which read it as a
            // second DEFAULT; both now go through one recogniser.
            `[data-app-page-frame][ data-block-id = 'spaced' ] {}\n`
        )
      ),
      'POSITIVE CONTROL FAILED: the shared `blockIdsIn` did not extract every legal CSS ' +
        'spelling of a per-app selector — there are FIVE: quoted, unquoted, substring operator, ' +
        'trailing `i` flag, and whitespace inside the bracket. ' +
        'The `[]` this test reports for the real ledger therefore carries no information — a ' +
        'capped app written in a spelling the extractor misses would read as an empty ledger. ' +
        'Fix `test/ledger-block-ids.ts` before reading the verdict below.'
    ).toEqual(['flagged', 'partial', 'quoted', 'spaced', 'unquoted']);
    expect(
      blockIdsIn(code(`/* [data-app-page-frame][data-block-id='in-a-comment'] {} */`)),
      'POSITIVE CONTROL FAILED the other way: a selector inside a CSS comment was counted as ' +
        'a member, so the "HOW TO ADD ONE" template in globals.css would trip this expectation ' +
        'and the ledger could never read as empty.'
    ).toEqual([]);

    const members = blockIdsIn(code(read(GLOBALS_CSS)));

    expect(
      members,
      'the platform width-cap ledger in src/styles/globals.css is no longer empty. If you ADDED ' +
        'an entry, you have made the platform impose a width on one app — add its block id to ' +
        'this expectation in the same commit with a reason on the rule, and make sure the id is ' +
        "the app's `app_blocks.block_id` (what `PageBlockHost` stamps as `data-block-id`) rather " +
        'than a listing slug; for an on-site app they are identical by construction ' +
        '(`app-listing-mapper.ts` sets `slug: ab.blockId`), which is exactly the condition under ' +
        'which the wrong one goes unnoticed. Note that an app can set its own width inside its ' +
        'own document and needs nothing from this ledger to do it.'
    ).toEqual([]);
  });

  /**
   * 🔴 PIN THE WHOLE EXPRESSION, NOT FEATURES OF IT — the lesson
   * `pageRunScrollContract.test.ts` paid for. A presence check on the token
   * `maxWidth` survives every mutation that matters here:
   *
   *   · dropping `marginInline: 'auto'` — inert today, and that is exactly why it
   *     needs pinning: at a default of `none` there is no leftover inline space to
   *     distribute, so its loss changes NOTHING that any tier can measure, and it is
   *     discovered only by whoever next adds a per-app cap and finds the whole gutter
   *     landing on the right
   *   · dropping the `var()` and hardcoding a width — the two tests above still pass
   *     and any per-app rule silently stops working
   *   · changing the fallback — the width a host rendered without globals.css gets,
   *     which the rendered tier structurally cannot see (its harness always supplies
   *     the `:root` properties)
   *
   * The accepted cost is that a cosmetic reformat of this exact pair fails this
   * test. That is the trade for a machine-checkable claim, and `code()` runs
   * first, so commenting a line out changes the string exactly as deleting it does.
   */
  it("pins the host's width declarations verbatim — a dropped `auto` margin, `var()` or fallback all fail", () => {
    const src = code(read(HOST));
    expect(
      region(
        src,
        /maxWidth: 'var\(--app-page-max-width[\s\S]*?marginInline: 'auto',/,
        'width pair'
      ),
      'This is a DELIBERATE verbatim pin, not an incidental string match. If you changed this ' +
        'pair on purpose (including a pure reformat), update the expected string here in the ' +
        'same commit. If you did not, you have either lost the centring a future per-app cap ' +
        'depends on, hardcoded a width past the per-app rule mechanism, or changed the fallback ' +
        'that applies to a host rendered without globals.css.'
    ).toBe("maxWidth: 'var(--app-page-max-width, none)', marginInline: 'auto',");
  });

  /**
   * 🔴 THE CAP AND THE CHROME ARE ON DIFFERENT ELEMENTS NOW, AND UNTIL THIS GUARD
   * EXISTED THE NODE TIER COULD NOT SEE THAT AT ALL.
   *
   * The width declarations used to sit on the host root, so the two guards above — "the
   * width pair appears verbatim somewhere" and "`data-block-id` is on the frame" —
   * described the SAME element and together implied the mechanism. Moving them down to
   * `app-page-content` broke that composition silently: each guard still passes
   * while describing a different element, and nothing asserts the bounded box is a
   * DESCENDANT of the frame — which is exactly the relationship a per-app width rule
   * depends on, since the custom property is set on the frame and read one level down.
   *
   * Measured by mutation, in a copy: reverting the whole change (the width pair back
   * on the frame, chrome bounded again) left the FULL node suite — 1569 files, 24,879 tests
   * — byte-identically green. Only the browser tier caught it, and that tier is
   * report-only everywhere. This test is the node-tier half — the one that renders
   * an honest verdict on a push to `main` or a `workflow_dispatch` (neither tier
   * blocks a merge; see the header).
   */
  it('the width pair sits on `app-page-content`, and that box is a real DESCENDANT of the frame', () => {
    const { frame, content } = hostElements();

    // 🔴 CONTAINMENT IS ASSERTED ON THE PARSE TREE, NOT BY COMPARING TEXT OFFSETS, AND
    // THE DIFFERENCE IS THE ENTIRE VALUE OF THIS TEST. An earlier version asked whether
    // `app-page-content` appeared LATER IN THE FILE than `app-page-frame` — which every
    // sibling, cousin and unrelated later element also satisfies. Measured on that
    // version: closing the frame before the content box, so the two are genuine SIBLINGS
    // and a per-app rule's inheritance is dead, left this file 9/9 green AND the whole
    // node suite (1569 files / 24,879 tests) byte-identically green, while the
    // report-only browser tier correctly failed BOTH of its ledger tests. A guard whose message
    // says "no longer renders inside" must actually mean inside.
    expect(
      isDescendant(frame, content),
      '`app-page-content` is no longer a DESCENDANT of `app-page-frame`. A per-app width ' +
        'rule sets `--app-page-max-width` ON THE FRAME and relies on CSS INHERITANCE to reach ' +
        'the box that reads it, so lifting that box out from under the frame — even into a ' +
        'sibling that still renders — makes any such rule silently inert. (Nothing is capped ' +
        'today, so nothing VISIBLE breaks: what breaks is the next rule anyone writes, which is ' +
        'why this stays pinned with an empty ledger.) This node tier renders nothing, so this ' +
        'source-level ' +
        'containment check is its only view of the relationship; the only tier that ' +
        'can observe it at runtime is the report-only browser tier.'
    ).toBe(true);

    // The width pair must live in the CONTENT element's style prop, not the FRAME's.
    //
    // 🔴 READ OFF THE ELEMENT'S OWN `style` ATTRIBUTE, NOT A TEXT SLICE BETWEEN THE TWO
    // TESTIDS. Two successive text-based attempts were each defeated by where the
    // characters happened to fall: the first started at the frame's `data-testid` and so
    // began AFTER its `style={{…}}` (JSX orders them that way), and the second anchored on
    // `lastIndexOf('<', …)`, which finds the nearest preceding `<` — the opening tag only
    // while nothing in the element's own props contains one. Measured: inserting an
    // ordinary prop holding a `<` before the testid re-opened the hole and the
    // pair-back-on-the-frame mutant passed this test again. The attribute's own text has no
    // such ambiguity.
    // 🔴 COMMENTS STRIPPED FIRST, SO PROSE INSIDE THE STYLE OBJECT CANNOT DECIDE THIS. The
    // frame's `style={{…}}` carries a long inline comment that NAMES `--app-page-max-width`
    // (it explains why the frame is full-bleed and how a per-app rule reaches the wrapper
    // below), and `styleObjectOf` returns the literal's raw text, comments included. So the
    // un-stripped form failed this assertion on a comment — the "a guard can be satisfied,
    // or broken, by prose ABOUT the rule" trap, reached here through the NEGATIVE direction.
    // Measured while making the surface uncapped: the frame comment gained the property's
    // name and this test went red with nothing about the styles changed.
    //
    // ⚠️ BE PRECISE ABOUT THE DIRECTIONS, BECAUSE "does not weaken either claim" WAS TOO
    // STRONG. For the `.toContain` below, stripping makes the claim strictly STRONGER — prose
    // can no longer satisfy it. For `.not.toContain` it is necessary to avoid a FALSE RED, but
    // it does WIDEN what can pass: the shared stripper's `//` pass is guarded only against a
    // preceding `:`, so a same-line `url(//cdn/x.png)` before an inline
    // `['--app-page-max-width']` would take the declaration out with it. What actually closes
    // that direction is the INVARIANT below, which greps the whole host file for an inline
    // custom property — not this assertion.
    //
    // 🔴 `stripTsComments`, NOT THE LOCAL `code()`, AND THE DIFFERENCE IS THE POINT HERE: the
    // shared module also removes TRAILING `//` comments. `code()` only strips a `//` that
    // STARTS a line, so a trailing `// … --app-page-max-width …` on a real style property
    // would survive it and fail this assertion on prose all over again — the same defect one
    // comment syntax over. This input is pure TypeScript, so the shared stripper is safe here
    // in a way it is not for the CSS reads (see `code()`).
    const frameStyle = stripTsComments(readableStyleOf(frame, 'app-page-frame'));
    expect(
      frameStyle,
      'the `--app-page-max-width` declaration is on the host FRAME again. That puts the app ' +
        'chrome under the same bound as the app, so any per-app cap would make a full-page app ' +
        'render as a boxed widget dropped into the page rather than as a page of the site.'
    ).not.toContain('--app-page-max-width');
    // 🔴 AND NO BARE `max-width` DECLARATION EITHER, IN ANY SPELLING — the assertion above checks one
    // SPELLING while its message claimed a check on "the `max-width` declaration" (now corrected),
    // and the gap between the two was a SURVIVING MUTANT. Measured: adding
    // `maxWidth: 1600, marginInline: 'auto'` to the frame's inline style re-caps the chrome AND the
    // app — the exact regression the frame/content split exists to prevent — and left this file
    // 10/10, `ledgerSelectorSurvivesProdStrip` 7/7, and the `region()` width-pair anchor still
    // matching exactly once (it anchors on `maxWidth: 'var(`). Only the REPORT-ONLY browser tier
    // went red, against a file whose stated purpose is a verdict that is honest on `main`. With
    // this assertion the same mutant dies here at 1 failed | 9 passed of 10 arms in this file.
    //
    // 🔴 AND IT TOOK TWO ROUNDS TO GET THE SPELLINGS RIGHT, WHICH IS THE REUSABLE PART. The first
    // version was `/(?:^|[,{\s])maxWidth\s*:/` and its comment already promised "any `maxWidth`
    // on the frame, however it is spelled" — wider than the regex. Three legal JS/React respellings
    // walked it, all measured: `'maxWidth':` (prettier rewrites this one back to the caught form,
    // so it self-heals), `['maxWidth']:` (a computed key, semantically identical, prettier KEEPS
    // it), and `'max-width':` — which caps in production because react-dom's `setValueForStyles`
    // assigns `style[key] = value` for every non-`--` key and CSSOM exposes the dashed attribute,
    // with only a DEV warning. The cure was already one screen up in this file: test 1's pattern #2
    // is `/['"`]--app-page-max-width['"`]\s*\]?\s*:/` — quotes AND a computed-key `\]?`. This
    // mirrors it. `maxWidthSomething:` and `minWidth:` stay clean, and `--app-page-max-width` is
    // excluded because a `-` precedes it, so the assertion above keeps that case and its message.
    //
    // 🔴 TWO MORE ROUNDS WENT INTO THE SPELLINGS, AND BOTH CORRECTIONS ARE THE SAME MISTAKE FROM
    // OPPOSITE SIDES. (a) The quote class was `['"]` while the pattern it claimed to MIRROR —
    // test 1's #2 — is `['"\`]`: a BACKTICK computed key `` [`maxWidth`]: `` therefore walked it,
    // and prettier PRESERVES that form. ⚠️ AND "only the backtick and bare-bracket forms are
    // stable" WAS ITSELF A CHECKABLE CLAIM AND ALSO FALSE — measured with this repo's prettier
    // config, FOUR are stable: `['maxWidth']:`, `` [`maxWidth`]: ``, `'max-width':` and
    // `'max-inline-size':` (prettier cannot unquote a DASHED key). Only the camelCase quoted forms
    // `'maxWidth':` / `'maxInlineSize':` get rewritten to the bare identifier. Nothing is
    // uncovered either way — the regex catches all six — but a comment that counts is a comment
    // that goes stale. "This mirrors it" was the first such claim in this paragraph and it was
    // false too. (b) The heading and message had been widened to "ANY WIDTH
    // PROPERTY", which overshot in the other direction: `maxInlineSize` — the logical equivalent,
    // same regression with `marginInline: 'auto'` — was NOT matched, while the sentence also
    // promised to forbid `width`, which the frame legitimately declares as `width: '100%'`. So an
    // unenforceable claim sat over a gap. The regex now covers `max-width` AND `max-inline-size` in
    // every quoting/computed-key form, and the wording claims exactly that and no more.
    //
    // ⚠️ IT DOES FIRE ON `maxWidth: 'none'`, which is not a cap. Accepted: the frame has no
    // business declaring a max-width at all, so the advice the message gives is still right, and a
    // value allowlist would be the kind of narrowing that re-opens the hole.
    //
    // ⚠️ AND IT IS STILL SCOPED TO THE INLINE `style` OBJECT. Two other routes reach this same
    // element without touching it — a Mantine width STYLE PROP and a Tailwind width CLASS — and
    // each has its own assertion below.
    expect(
      frameStyle,
      'the host FRAME now declares a `max-width` (or `max-inline-size`) in its inline style, in ' +
        'some spelling. That bounds the app CHROME as well as the app, which is the regression the ' +
        'frame/content split exists to prevent — and it does so WITHOUT touching ' +
        '`--app-page-max-width`, so it is invisible to the assertion above, to the ledger, and to ' +
        'the globals.css gate. The frame is full-bleed by design: if a width is wanted, put it on ' +
        "`app-page-content` via the custom property. (`width: '100%'` is legitimate and is NOT " +
        "what this matches. `maxWidth: 'none'` IS matched even though it caps nothing — remove it " +
        'anyway; the frame declaring a max-width at all is the thing being pinned.)'
    ).not.toMatch(/(?:^|[,{[\s])['"`]?max-?(?:width|inline-?size)['"`]?\s*\]?\s*:/i);

    // 🔴 AND NO MANTINE WIDTH STYLE PROP, ON EITHER BOX. THIS IS THE CHEAPEST ROUTE OF ALL AND IT
    // SURVIVED THE ROUND THAT CLOSED THE INLINE ONE, because neither element is a `div` — both are
    // `<Box>` from `@mantine/core`, and Mantine's style props are not decoration.
    // `style-props-data.mjs` maps `maw → maxWidth`, `w → width`, `miw → minWidth`, and
    // `get-box-style.mjs` returns `{ ..._style, ..._vars, ...styleProps }` — i.e. a style prop is
    // merged into the element's INLINE STYLE and WINS over the explicit `style` prop. So
    // `maw={1600}` is a real max-width in production, unconditionally.
    //
    // 🔴 BOTH ELEMENTS, BECAUSE SCOPING THESE TO THE FRAME LEFT THE HEADLINE REGRESSION OPEN — the
    // round that added them checked the frame only, and a review then measured `maw={1600}` on
    // `app-page-content` passing ALL TEN arms of this file. That one is WORSE than the frame case,
    // not better, in two ways: the content box is where `maxWidth: 'var(--app-page-max-width, none)'`
    // actually lives and `styleProps` merges LAST, so the prop does not merely add a cap — it
    // OVERRIDES the custom property outright, making the per-app rule mechanism and the empty
    // ledger inert in one attribute; and a content cap bounds the APP COLUMN, which is the precise
    // regression this change exists to remove, where a frame cap bounds chrome-plus-app. Only the
    // report-only browser tier saw it. The predicates are therefore run over BOTH elements.
    //
    // ⚠️ AND MANTINE IS MORE IDIOMATIC HERE THAN THE TAILWIND FORM, WHICH AN EARLIER VERSION OF
    // THIS COMMENT CALLED "the most idiomatic one in this codebase". Measured at HEAD on ONE corpus,
    // `git grep -oh <pat> -- 'src/components/**/*.tsx'`: `maw=` **136**, `max-w-` **114** (and
    // `maw=` is 191 across `src/**/*.tsx`). ⚠️ THAT PAIR PREVIOUSLY READ "136 vs 119" AND WAS
    // MEASURED ON TWO DIFFERENT CORPORA — 136 over `*.tsx`, 119 over `*.tsx` plus `*.ts` at the
    // PREVIOUS commit, which this file's own edit then invalidated by adding `max-w-` mentions to
    // itself. The conclusion held on both pairings; the figures did not. Name the invocation, or
    // quote a bound that cannot rot. The exact mutant already exists verbatim nearby —
    // `<Box maw={1000} mx="auto">` in `src/components/Collections/CollectionsLanding.tsx`, and
    // `<Box maw={appsMeasureCss(measure)}>` in `src/components/Apps/AppsPageLayout.tsx`, i.e. in the
    // Apps neighbourhood itself.
    //
    // 🔴 `w` IS INCLUDED, `miw` IS NOT, AND THE ASYMMETRY IS THE POINT. `w={1600}` hard-sets
    // `width` past each box's own `width: '100%'` by that same precedence, so it caps. `miw` sets a
    // MINIMUM: it cannot cap, it can only force overflow — a different defect, not this one, and
    // pinning it here would widen the claim past what the message can honestly say. Those three are
    // the COMPLETE width-touching set: of Mantine's style props, exactly `w`/`miw`/`maw` map to a
    // width property.
    //
    // ⚠️ THREE THINGS THESE ARMS DO NOT CLAIM, stated so none reads wider than it is. (a) They
    // over-fire on values that cap nothing — `w="100%"` is semantically identical to the
    // `width: '100%'` both boxes already declare, and `min-w-[…]` / `max-w-none` cap nothing
    // either; all fail RED, which is the safe direction, but the message's "put it on
    // app-page-content via the custom property" advice is wrong for those. (b) `maw={1600}` resolves
    // through Mantine's `spacingResolver` to `calc(100rem * var(--mantine-scale))`, not `1600px` —
    // so it is root-font-size AND scale dependent; the mechanism is unaffected, the arithmetic is
    // not exact. (c) The merge-order sentence above holds for every value that is not RESPONSIVE to
    // Mantine — which is a narrower set than "an object". ⚠️ THIS CLAUSE PREVIOUSLY NAMED
    // `maw={{ base: 1600 }}` AS THE LOSING CASE AND THAT IS RETRACTED: measured by calling
    // `parseStyleProps` directly, `hasResponsiveStyles` is FALSE when `base` is the only key, so
    // that value merges last via `getBoxStyle` and WINS over the `style` object exactly like the
    // plain number. The class-rule form — which does lose to inline style — needs at least one
    // non-`base` breakpoint, e.g. `maw={{ base: 1600, md: 1200 }}` or `maw={{ sm: 1600 }}`. The old
    // wording was reassuring in the wrong direction: an editor told a `base`-only object "loses to
    // inline style" could relax these arms for object values and ship a full-priority inline cap.
    // These arms fire on the attribute NAME, so they catch every form regardless — body wider than
    // description, safe direction.
    //
    // ⚠️ AND THEY ARE SPREAD-BLIND ON THEIR OWN. `{...capProps}` is caught only because
    // `styleObjectOf` returns `null` on any `JsxSpreadAttribute`, via `readableStyleOf` — for the
    // FRAME that call runs above this loop, and for the CONTENT element it runs BELOW it (the
    // `.toContain('--app-page-max-width')` arm). ⚠️ An earlier version of this note named the
    // frame's call alone while governing both elements, which sends a reader to the wrong line for
    // half of what it protects. Either way it is inherited safety, not local safety: re-point or
    // relax EITHER style arm and the three arms for that element lose it silently.
    for (const [testid, element] of [
      ['app-page-frame', frame],
      ['app-page-content', content],
    ] as const) {
      const attrs = element.attributes.properties.filter(ts.isJsxAttribute);
      const attrText = attrs.map((attr) => norm(attr.getText()));
      // 🔴 THE CONSEQUENCE DIFFERS BY ELEMENT AND BY ROUTE, AND FLATTENING THAT WAS ITS OWN FALSE
      // CLAIM. A STYLE PROP (`maw`/`w`) merges AFTER the `style` object, so on the content element
      // it overrides `--app-page-max-width` outright — the app column, capped, mechanism dead. A
      // CLASS-borne cap (a Tailwind utility, or a substituted component's own root class) is
      // author-origin CSS with no `!important`, so on the content element it LOSES to that
      // element's existing inline `maxWidth`. ⚠️ WHAT IT DOES INSTEAD IS ROUTE-SPECIFIC, and the
      // messages below generalised past that: a `max-w-*` utility carries no padding, so there it
      // is simply INERT; a `Container` substitution yields `padding-inline` — a ~16px inset of the
      // app column — because that inset lives in Container's own root class, not in "a class-borne
      // width" generally. Neither is a cap. (Verified: `tailwind.config.js` sets no `important` and
      // no `prefix`, so Tailwind utilities really are ordinary author declarations here; had
      // `important: true` been set, this whole half would invert in the dangerous direction.) ⚠️ An earlier version of
      // these messages asserted the 960px letterbox on BOTH elements; it is unopposed only on the
      // FRAME, which declares no `maxWidth` of its own. Safe direction — every arm still fires on
      // both elements — but it is the sentence carrying the reason.
      const where =
        testid === 'app-page-content'
          ? 'On THIS element a width STYLE PROP overrides `--app-page-max-width` outright (Mantine ' +
            'merges style props after the `style` object), capping the APP COLUMN and killing the ' +
            'per-app rule mechanism in one attribute. A CLASS-borne width instead LOSES to that ' +
            'inline `maxWidth` and does nothing here at all — except that a substituted ' +
            "component's own root class can still inset the column through its `padding-inline` " +
            '(`Container` adds ~16px a side). Neither belongs here. '
          : 'On THIS element nothing else declares a `max-width`, so any of these is UNOPPOSED: it ' +
            'bounds the app CHROME as well as the app, which is the regression the frame/content ' +
            'split exists to prevent. ';

      expect(
        attrs.map((attr) => attr.name.getText()).filter((n) => n === 'maw' || n === 'w'),
        `\`${testid}\` now carries a Mantine width style prop (\`maw\` / \`w\`). ` +
          where +
          '`<Box>` merges style props into the element’s INLINE STYLE and they WIN over the ' +
          '`style` prop, so this is a real `max-width` / `width` in production — and it touches ' +
          'neither `--app-page-max-width` nor the `style` object, so every style assertion is ' +
          'blind to it. If a width is genuinely wanted, express it as a per-app ' +
          '`--app-page-max-width` rule in globals.css, where the membership enumeration and the ' +
          'rendered arms can both see it. (`miw` is deliberately NOT pinned — a minimum cannot ' +
          'cap, only force overflow. `w="100%"` caps nothing either and still fails here; remove ' +
          'it rather than relaxing this.)'
      ).toEqual([]);

      // 🔴 AND NO TAILWIND WIDTH UTILITY. Tailwind is configured, `max-w-` appears 114 times under
      // `src/components/**/*.tsx`, and neither element carries a `className` today — so
      // `className="max-w-[1600px] mx-auto"` is a route someone re-capping this would plausibly
      // reach for. Both tiers are blind to it: the style assertions read the `style` object, the
      // globals.css gate's corpus is that one file, and the browser harness loads no Tailwind, so
      // the class resolves to nothing there. (The Mantine STYLE-PROP and inline routes the browser
      // tier does see — it is only report-only, which is why they are pinned here too.) ⚠️ NOT "the
      // ONE route both tiers are blind to", which this comment claimed until a review found a
      // second: swapping the element's COMPONENT for `<Container>` is equally invisible to both,
      // and it is pinned by the tag-name arm below.
      expect(
        attrText.filter((attr) => /^class(?:Name)?=/.test(attr) && /\b(?:max-w-|w-\[)/.test(attr)),
        `\`${testid}\` now carries a Tailwind width utility (\`max-w-*\` / \`w-[…]\`). ` +
          where +
          'It is invisible to every other guard here AND to the browser tier, whose harness loads ' +
          'no Tailwind. If a width is wanted, express it as a per-app `--app-page-max-width` rule ' +
          'in globals.css. (`min-w-[…]` and `max-w-none` cap nothing and still fail here; remove ' +
          'them rather than relaxing this.)'
      ).toEqual([]);

      // 🔴 AND THE COMPONENT ITSELF MUST STILL BE `Box`, WHICH IS A CHEAPER RE-CAP THAN ANY OF THE
      // ROUTES ABOVE AND SURVIVED THE ROUND THAT CLOSED THEM. Swapping `<Box>` for `<Container>` —
      // three lines: add `Container` to the existing `@mantine/core` import and rename the open and
      // close tags — caps this element at Mantine's `--container-size-md`, i.e. **960px**, via
      // `max-width: var(--container-size)` plus `margin-inline: auto` in
      // `@mantine/core/styles.layer.css`, which `src/pages/_app.tsx` imports. Nothing else declares
      // a `max-width` on the frame, so it is unopposed — a TIGHTER letterbox than the 1600px this
      // change exists to remove, shipped by a rename.
      //
      // 🔴 AND IT IS INVISIBLE TO EVERY OTHER ARM AND TO BOTH TIERS. Measured: the mutation leaves
      // `isDescendant`, `readableStyleOf`, both `.not.toContain`/`.not.toMatch` style checks and all
      // six attribute arms byte-identical to baseline — 10/10 green — because it adds no attribute
      // and no `--app-page-max-width` declaration. And neither tier loads `@mantine/core/styles.css`
      // (`test/component-setup.tsx` extracts only `:root` custom properties), so the Container class
      // is unstyled in the browser tier and the rendered width stays 100% there too.
      //
      // ⚠️ THERE IS A THIRD RENDERED TIER AND THE SENTENCE ABOVE DOES NOT COVER IT. The `geometry`
      // project's setup (`test/geometry-setup.tsx`) DOES import `@mantine/core/styles.layer.css` and
      // `~/styles/globals.css`, and `PageBlockHostFillHeight.geometry.test.tsx` renders the real
      // host. Checked whether it would catch either mutant: it would NOT — it mounts at 390x844 and
      // 390x640, so a 960px Container cap and a `max-w-[1600px]` class are both inert at that width,
      // Container adds only horizontal declarations, and every assertion there is height/flex-axis
      // based. The survivability conclusions stand; only "neither tier loads the Mantine stylesheet"
      // was too broad — it is true of the two tiers THIS file pairs with.
      //
      // ⚠️ PLAUSIBLE, NOT THEORETICAL: `<Container` appears 272 times in `src/**/*.tsx`, including
      // in `src/components/Apps/AppsPageLayout.tsx` — the same file the Mantine note above cites as
      // "the Apps neighbourhood itself".
      //
      // ⚠️ AN ALLOWLIST, AND DELIBERATELY A ONE-ITEM ONE — BUT NOT FOR THE REASON THIS COMMENT
      // FIRST GAVE. It claimed "`Container`, `Paper`, `Card` and `AppShell.Main` all carry their own
      // measures", and that is FALSE for three of the four: measured against
      // `@mantine/core/styles.layer.css` at this HEAD, only `Container`'s root class declares
      // anything width-related (`max-width: var(--container-size)`, `padding-inline`,
      // `margin-inline: auto`). `Paper` (`.m_1b7284a3`) and `Card` (`.m_e615b15f`) declare none, and
      // `AppShell.Main` (`.m_8983817`) declares only paddings and `min-height`. The error ran in the
      // safe direction — it over-stated the hazard to justify a stricter guard — but it is the
      // sentence carrying the rationale, and an editor wanting `<Paper>` for visual chrome was being
      // told, wrongly, that the swap letterboxes the app.
      //
      // The allowlist survives on the honest ground instead: ANY component can declare a width in
      // its own CSS, the set is open across Mantine versions and app-local wrappers, and a denylist
      // is therefore the losing side of that race. `Box` is the only component either of these
      // elements has any business being, so the pin is "it is still Box" and a deliberate change has
      // to come here and argue. ⚠️ This says nothing about a `div` — a plain `<div>` would also be
      // fine and would fail this arm; that is the accepted cost of an allowlist over a denylist, and
      // re-pointing it is a one-word edit made on purpose. Same for `<Container fluid>`, which is
      // width-neutral and still blocked.
      expect(
        element.tagName.getText(),
        `\`${testid}\` is no longer a Mantine \`Box\`. Several Mantine components carry their own ` +
          'width measure — `Container` caps at `--container-size-md` (960px) via ' +
          '`@mantine/core/styles.layer.css`, which `src/pages/_app.tsx` imports — so a component ' +
          'swap can letterbox this element more tightly than the 1600px cap this change removed, ' +
          'while adding no attribute and no `--app-page-max-width` declaration. That makes it ' +
          'invisible to every other assertion here AND to the browser tier, whose harness does not ' +
          'load the Mantine stylesheet. If the component must change, verify the new one imposes no ' +
          'width and re-point this pin in the same commit.'
      ).toBe('Box');

      // 🔴 AND NO `component` OR `renderRoot` PROP, BECAUSE `Box` IS POLYMORPHIC AND THE TAG NAME
      // IS THEREFORE NOT THE RENDERED COMPONENT. Mantine builds `Box` with
      // `createPolymorphicComponent`, and `Box.mjs` decides the root on ONE line:
      // `typeof renderRoot === 'function' ? renderRoot(props) : jsx(Element, { ...props })` — so
      // BOTH props substitute it. `<Box component={Container} …>` and
      // `<Box renderRoot={(p) => <Container {...p} />} …>` each render a `Container`, which applies
      // its own root class unconditionally: on the FRAME that is the same
      // `max-width: var(--container-size)` + `margin-inline: auto` 960px letterbox the arm above
      // exists to stop, reached by ONE ATTRIBUTE instead of a three-line rename. Measured: either
      // mutant leaves `tagName` as `Box` and passes every other arm — neither name is in the
      // `maw`/`w` set, neither is a `className`, and the `style` object is untouched, so both style
      // assertions and `readableStyleOf` pass too.
      //
      // 🔴 `renderRoot` IS PINNED BECAUSE IT IS THE ROUTE THIS REPO PREFERS, WHICH MADE IT THE
      // WORSE OMISSION. A first version of this arm filtered `component` alone, and a review
      // measured `renderRoot={(p) => <Container {...p} />}` surviving every arm on both elements.
      //
      // ⚠️ AND THE JUSTIFICATION FOR WIDENING IT WAS ITSELF OVERSTATED, WHICH IS WORTH MORE THAN
      // THE ARITHMETIC. It read "live local idiom (12 occurrences across 3 files)". The 12 is
      // textually right and characterises them wrongly: enumerated, there is exactly **ONE** real
      // `renderRoot={` PROP USAGE in `src/` — `src/components/Apps/RecentlyOpenedApps.tsx:370` —
      // while five more occurrences in that file and two in its browser test are COMMENT PROSE
      // about it, and the remaining four are `const renderRoot = async () => {…}`, an unrelated
      // local render helper in `src/components/Sticker/__tests__/`, i.e. a pure name collision.
      // The neighbouring counts in this file are honest because they are stated as raw text
      // ("`<Container` appears 272 times"); this one asserted USAGE.
      //
      // The pin survives on the honest ground, and it reads stronger: the ONE `renderRoot` usage
      // in `src/` is in the Apps neighbourhood this comment's plausibility argument already cites,
      // and that call site's own comment states the preference outright — routing a typed root
      // through `component=` produces a generic-component TS2322 while `renderRoot` keeps the
      // typing local. (That rationale is about a typed `<Link>` or branching the root element, not
      // about a bare `component={Container}`, which would typecheck fine; it explains the repo's
      // preference, not why the mutant compiles.) So the arm was blocking the discouraged prop and
      // leaving the encouraged one open, under a heading ("the tag name is not the rendered
      // component") that is true of both.
      //
      // ⚠️ AND `renderRoot` IS NOT A `BoxProps` MEMBER, which this comment previously claimed. It
      // comes from `PolymorphicComponentProps` in
      // `node_modules/@mantine/core/lib/core/factory/create-polymorphic-component.d.ts`, a union
      // whose `(props: Record<string, any>) => any` branch — the one quoted here — is the branch
      // that REQUIRES a `component` prop. The branch that applies to `<Box renderRoot={…}>` with no
      // `component` is `renderRoot?: (props: any) => any`. Wrong owner, wrong branch, and the
      // conclusion ("nothing upstream stops it") holds MORE strongly under the correct one — but a
      // reader grepping `BoxProps` to check it could not reproduce it.
      //
      // ⚠️ SO THE ARM ABOVE CHECKS A SPELLING WHILE ITS HEADING AND MESSAGE CLAIM THE ELEMENT'S
      // IDENTITY — the same description-wider-than-body shape this loop has now been corrected for
      // three times. This arm is what makes that heading true. And the route is established local
      // idiom, not exotic: `component={…}` appears on Mantine elements throughout `src/`, including
      // with layout components (`component={Center}`, `component={Card}`, `component={ScrollArea}`).
      //
      // ⚠️ A `component` prop is not inherently a cap — `component="section"` imposes nothing. It is
      // pinned anyway for the allowlist reason above: whether the substituted component declares a
      // width is not knowable from here, and both elements carry only `style` + `data-*` today, so
      // this is a true and currently-satisfied constraint rather than a speculative one. If one is
      // genuinely needed, verify the target imposes no width and re-point this arm in the same
      // commit. (An `import { Container as Box }` alias also walks the pair of arms; that is
      // adversarial disguise rather than a plausible re-cap, and is deliberately not chased.)
      expect(
        attrs
          .map((attr) => attr.name.getText())
          .filter((n) => n === 'component' || n === 'renderRoot'),
        `\`${testid}\` now carries a \`component\` or \`renderRoot\` prop. Mantine's \`Box\` is ` +
          'POLYMORPHIC and decides its root from either one, so the JSX tag name no longer tells ' +
          'you what renders — both `component={Container}` and ' +
          '`renderRoot={(p) => <Container {...p} />}` render a `Container`, which applies its own ' +
          '`max-width: var(--container-size)` (960px) + auto margins from ' +
          '`@mantine/core/styles.layer.css`. ' +
          where +
          'It is invisible to every other assertion here (neither name is a width style prop or a ' +
          'className, and neither touches the `style` object) and to both rendered tiers. If a ' +
          'substituted root is genuinely needed, confirm it declares no width and re-point this ' +
          'arm in the same commit.'
      ).toEqual([]);

      // 🔴 AND THE CLASS VALUE MUST BE READABLE AT ALL — the null-vs-empty-string lesson
      // `styleObjectOf` records, one attribute over. The token filter above scans the attribute's
      // TEXT, so `className={FRAME_CLASS}` (or `{cx(styles.frame)}`, or a `clsx` call over a module
      // constant) contains no literal `max-w-`, the filter returns `[]`, and the arm is GREEN while
      // the element is capped. `styleObjectOf` exists precisely because returning a falsy "nothing
      // here" for an unreadable value "SHIPPED THE HEADLINE REGRESSION GREEN"; an unreadable
      // className is the same shape and must FAIL rather than pass.
      expect(
        attrText.filter(
          (attr) => /^class(?:Name)?=/.test(attr) && !/^class(?:Name)?=\s*['"]/.test(attr)
        ),
        `\`${testid}\`'s \`className\` is not a plain string literal, so the width-utility ` +
          'filter above cannot read it and would pass on a capped element. Either inline the ' +
          'classes as a literal, or re-point these assertions at wherever the value now lives — an ' +
          'unreadable value must be a reason to FAIL, never a reason to pass.'
      ).toEqual([]);
    }

    expect(
      stripTsComments(readableStyleOf(content, 'app-page-content')),
      'the `max-width` declaration is no longer on `app-page-content`. If it moved, this ' +
        "guard and a per-app rule's inheritance both need re-deriving."
    ).toContain('--app-page-max-width');
  });

  /**
   * 🔴 `flex: 1` ON THE CONTENT WRAPPER IS LOAD-BEARING AND NOTHING RENDERED CATCHES
   * ITS LOSS — which is why this pins the whole style object rather than one token.
   *
   * Measured by mutation, in a copy: deleting `flex: 1` left the FULL node suite
   * (24,879 tests) AND the full `AppBlocks` browser tier (40 files / 484 tests)
   * green, while the app column and its iframe collapsed to a sliver of their
   * height. A running App Block reduced to a strip, with every tier green in both
   * directions. This source pin is the only thing standing between that mutation
   * and production.
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
   * Pinned WHOLE, for the reason the neighbouring cap pin records: a presence check
   * on `flex` survives `flex: 0`, and one on `maxWidth` survives losing the auto
   * margins. The accepted cost is that a deliberate reformat of this block fails
   * this test — pay it, and update the string in the same commit.
   */
  it("pins the content wrapper's box model — a dropped `flex: 1` collapses the app with every suite green", () => {
    const { content } = hostElements();
    // 🔴 COMMENTS STRIPPED FIRST, FOR THE SAME REASON AS THE CONTAINMENT ASSERTIONS ABOVE AND
    // TO REMOVE AN ASYMMETRY BETWEEN THEM. Those two now run through a stripper; this pin did
    // not, so the first inline comment added to THIS element's style literal would fail a
    // BOX-MODEL pin with a box-model message ("update the expected string"), reporting a
    // comment edit as a geometry change. That is the misattribution class this file records
    // twice already. Stripping costs nothing here — the expected string below contains no
    // comment — and `flex: 1` is untouched by it, so the mutation this pin exists for still
    // fails the equality.
    expect(
      norm(stripTsComments(readableStyleOf(content, 'app-page-content'))),
      "This is a DELIBERATE verbatim pin of `app-page-content`'s box model. `flex: 1` is " +
        'what makes this box consume the height the chrome left; without it the app column ' +
        'collapses to its content-based minimum and NO rendered test in either tier ' +
        'notices. If you changed this block on purpose, update the expected string here in ' +
        'the same commit.'
    ).toBe(
      "{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%', " +
        "maxWidth: 'var(--app-page-max-width, none)', marginInline: 'auto', }"
    );
  });

  /**
   * 🔴 A PER-APP WIDTH RULE'S SELECTOR IS A RELATIONSHIP BETWEEN TWO ATTRIBUTES ON ONE
   * ELEMENT, so that is what is asserted — not that each token appears somewhere
   * in the file.
   *
   * The documented shape (the template in globals.css, and the recipe in
   * `docs/features/app-blocks.md`) is `[data-app-page-frame][data-block-id='…']`. If
   * `data-block-id` moves to a different element, or is renamed, or is fed the
   * per-install `blockInstanceId` instead of the app's slug, such a rule matches
   * nothing — and nothing about the page looks wrong.
   *
   * ⚠️ WITH THE LEDGER EMPTY THERE IS NO LIVE RULE FOR THIS TO PROTECT, AND THAT IS NOT
   * A REASON TO DROP IT: what it protects is the NEXT rule, written from a template this
   * repo keeps and two test files check. A rename that silently invalidated both
   * templates would be discovered only by whoever wrote that rule and could not make it
   * work.
   *
   * The testid is only this guard's ANCHOR for finding the root element; a per-app rule
   * must not select on it (production strips it).
   *
   * 🔴 BOTH HALVES, ON THE PARSED FRAME ELEMENT — NOT A TEXT SEARCH OVER THE FILE.
   * `data-app-page-frame` was added by the fix that re-keyed the old ledger, and it
   * was originally pinned only by a whole-file substring search in
   * `ledgerSelectorSurvivesProdStrip.test.ts`. Measured: moving that attribute off
   * the host root onto the `app-page-content` wrapper — which re-creates the
   * shipped production defect exactly, since the compound selector then matches
   * zero elements — left the ENTIRE node tier byte-identically green
   * (`7 failed | 741 passed`, the same pre-existing failures, both ways). Only the
   * report-only browser tier caught it. Asking `hostElements()` for the frame and
   * reading ITS attribute list is what makes "on the root" a checkable claim.
   */
  it("stamps BOTH ledger attributes on the host root — a per-app rule's selector chains them", () => {
    const { frame } = hostElements();
    const attrs = frame.attributes.properties.filter(ts.isJsxAttribute);
    const names = attrs.map((a) => a.name.getText());

    expect(
      names,
      'the host ROOT no longer stamps `data-app-page-frame`. The per-app width rule documented ' +
        "in src/styles/globals.css selects on `[data-app-page-frame][data-block-id='…']` — a " +
        'compound selector, so BOTH halves must be on the SAME element. `data-testid` cannot ' +
        'stand in for it: `next.config.mjs` strips every testid from the production DOM, which ' +
        'is the defect that made this attribute necessary. Moving it to the content wrapper ' +
        'reads as a tidy-up and makes any such rule match nothing, with nothing visibly wrong.'
    ).toContain('data-app-page-frame');

    expect(
      names,
      'the host root no longer stamps `data-block-id`. A per-app width rule selects on ' +
        "`[data-app-page-frame][data-block-id='…']`, so no such rule can match anything."
    ).toContain('data-block-id');

    const blockIdAttr = attrs.find((a) => a.name.getText() === 'data-block-id');
    expect(
      norm(blockIdAttr!.getText()),
      'the host root stamps `data-block-id` from something other than `blockId`. `blockId` (the ' +
        'app slug, what builds `<slug>.civit.ai`) is the required value — `blockInstanceId` is ' +
        'per-install and is NOT what an app author knows their app by, so a rule written ' +
        'against the slug would match nothing.'
    ).toBe('data-block-id={blockId}');
  });

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — it passed before the cap existed,
   * passed while it existed, and passes now that it is gone, and is labelled so it is
   * never counted as proof of any of the three.
   *
   * What it protects is the ONE structural precondition of a per-app width rule. An
   * inline `style={{ '--app-page-max-width': … }}` on the host root would look like a
   * tidier way to spell the same thing and would render identically — but an
   * inline custom property beats every stylesheet rule on that element, which is
   * exactly the rule shape the ledger uses. Such a rule would become inert with
   * no visible change anywhere.
   */
  it('INVARIANT — the width is never written as an inline custom property, which would beat a per-app rule', () => {
    const src = code(read(HOST));
    expect(
      /['"`]--app-page-max-width['"`]\s*\]?\s*:/.test(src),
      'PageBlockHost.tsx now sets `--app-page-max-width` as an inline style property. An inline ' +
        'custom property wins over any stylesheet rule targeting the same element, so this makes ' +
        'any per-app rule in globals.css inert while rendering identically. Read the ' +
        'property with `var()`; declare it in globals.css.'
    ).toBe(false);
  });

  /**
   * 🔴 THE CHEAPEST WAY TO REINTRODUCE A CAP BYPASSES EVERY OTHER GUARD IN THIS FILE, BECAUSE
   * IT NEVER MENTIONS THE CUSTOM PROPERTY.
   *
   *     [data-app-page-frame] > div { max-width: 1600px; margin-inline: auto; }
   *
   * That re-caps every full-page App Block in production and is invisible to:
   *   · every assertion above, which greps `--app-page-max-width` — a bare `max-width` is not
   *     searched by any of the three declaration patterns;
   *   · the whole browser tier, because `test/component-setup.tsx` deliberately does not load
   *     the app cascade (it extracts only unconditional `:root` custom properties), so such a
   *     rule is never injected there and no rendered arm can see it.
   *
   * ⚠️ WHY THIS IS GATED NOW AND WAS NOT A ROUND AGO. It was first written up as documentation
   * only, justified by "zero instances in this file's history" — which is the wrong
   * denominator: dropping the default is exactly what makes this the cheap route, so the base
   * rate changed at the same moment the justification was written. The narrow version costs a
   * YAML-free regex over one file plus a control, so it is bought rather than argued about.
   *
   * ⚠️ SCOPE, STATED SO THIS IS NOT READ AS MORE THAN IT IS. THE CORPUS IS EXACTLY ONE FILE:
   * `globals.css`. "The host's own markers" is the SELECTOR FILTER applied within that file, not
   * a second corpus — an earlier wording ("it covers `globals.css` and the host's own markers")
   * read as if `PageBlockHost.tsx` were covered too, and it is not: an inline `maxWidth` in the
   * host's own `style={{…}}` is caught by the frame/content assertions further up this file, NOT
   * here. A cap arriving from a CSS Module, a component stylesheet, or a selector that reaches
   * the host box without naming it is also NOT covered — closing that needs the real cascade
   * loaded in the browser tier, which moves every other suite's geometry. This is the narrow
   * half, deliberately.
   *
   * 🔴 MUTATION CONTROL, IN THE TREE RATHER THAN IN A PR DESCRIPTION. Adding
   * `[data-app-page-frame] > div { max-width: 1600px; margin-inline: auto; }` to `globals.css`
   * fails THIS assertion with its own message — `expected [ '[data-app-page-frame] > div' ] to
   * deeply equal []` — at **1 failed | 9 passed of 10 arms in this file**. Quote that pair with
   * its arm total: a bare count goes stale the next time an `it` lands, which has now happened
   * three times in this segment.
   */
  it('no bare `max-width` rule in globals.css targets the app host box', () => {
    const css = code(read(GLOBALS_CSS));

    /**
     * A `max-width` declaration inside a rule whose selector names one of the host's markers.
     *
     * 🔴 CASE-INSENSITIVE, BECAUSE CSS IS. Property names and HTML attribute names are both ASCII
     * case-insensitive, so `MAX-WIDTH:` and `[DATA-APP-PAGE-FRAME]` are live caps — measured
     * against the first version of this gate, which was case-sensitive and returned `[]` for
     * `[data-app-page-frame] > div { MAX-WIDTH: 1600px; }`. The sibling exactly-one-default
     * message already anticipates this class for `[DATA-BLOCK-ID=…]`; this gate had not. The
     * `(?:^|[;\s])` prefix still keeps `--APP-PAGE-MAX-WIDTH` out, because that is preceded by a
     * `-`.
     */
    const hostCapRule =
      /([^{}]*(?:data-app-page-frame|data-block-id|app-page-content)[^{}]*)\{([^}]*)\}/gi;
    const offenders = (text: string) =>
      [...text.matchAll(hostCapRule)]
        .filter(([, , body]) => /(?:^|[;\s])max-width\s*:/i.test(body))
        .map(([, selector]) => selector.trim());

    // 🔴 POSITIVE CONTROL — this grep reports a ZERO, and a zero from a pattern that can never
    // match is indistinguishable from a clean file. Feed it the exact rule the docblock above
    // names, plus a near-miss that must NOT be flagged (the `--app-page-max-width` custom
    // property is this file's own mechanism and is covered by the assertions above; flagging
    // it here would make the ledger's own template an offender).
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
      offenders(`[data-app-page-frame][data-block-id='x'] { --app-page-max-width: 1100px; }`),
      'CONTROL FAILED the other way: the grep flagged a `--app-page-max-width` declaration as a ' +
        'bare `max-width`. That is the documented per-app mechanism, not an offender — the ' +
        'custom property is covered by the declaration-count assertions above.'
    ).toEqual([]);

    expect(
      offenders(css),
      'a rule in src/styles/globals.css sets a bare `max-width` on a selector naming the app ' +
        "host's own markers. That caps every full-page App Block (or one of them) WITHOUT going " +
        'through `--app-page-max-width`, so it is invisible to every other assertion in this ' +
        'file AND to the entire browser tier, whose harness does not load the app cascade. The ' +
        'platform is meant to impose no width: if a cap is genuinely wanted, express it as a ' +
        'per-app `--app-page-max-width` rule in the ledger so the membership enumeration and ' +
        'the rendered arms can both see it.'
    ).toEqual([]);
  });

  /**
   * globals.css has to keep the WORKED TEMPLATE for the per-app mechanism, whether or not any
   * rule uses it today. With the ledger empty, that template plus the publisher recipe are the
   * whole of what a future rule gets copied from.
   *
   * ⚠️ THIS ASSERTION WAS STRENGTHENED AFTER A REVIEW SHOWED IT COULD NOT FAIL FOR ITS OWN
   * STATED REASON. It used to be `expect(css).toContain('data-block-id')` over the raw file,
   * under a message reading "delete it and the next person re-derives it" — but the attribute
   * name also appears in the retracted-history prose and in the membership paragraph, so
   * deleting the entire template left it green. A check whose message names a consequence it
   * cannot observe reads as coverage while providing none. It now pins the template's SHAPE:
   * both selector halves chained on one element, and a `--app-page-max-width` declaration
   * inside the block.
   *
   * SCOPE, stated so this is not read as more than it is: this says a copyable template
   * EXISTS. Whether the attributes it names survive the production compiler, and whether
   * anything actually stamps them together, is owned by
   * `ledgerSelectorSurvivesProdStrip.test.ts`, which reads `next.config.mjs` and
   * `PageBlockHost.tsx` to answer it.
   */
  it('globals.css still carries a worked per-app template chaining both selector halves', () => {
    const css = read(GLOBALS_CSS);
    expect(
      TEMPLATE_RULE.test(css),
      'src/styles/globals.css no longer carries a worked "HOW TO ADD ONE" template of the shape ' +
        "`[data-app-page-frame][data-block-id='…'] { --app-page-max-width: …; }`. That template " +
        "is the only documented way for the platform to set ONE app's width, and with the " +
        'ledger empty the documentation IS the mechanism — delete it and the next person ' +
        're-derives it, probably onto `data-testid`, which production strips. Note this fails ' +
        'if either selector half is dropped, which mentioning `data-block-id` in prose does not ' +
        'satisfy — but it does NOT fail on a reorder to ' +
        "`[data-block-id='…'][data-app-page-frame]`, which is functionally identical, so do not " +
        'read a failure here as "a half is missing" without looking. The pattern is shared with ' +
        'the browser tier via `test/ledger-block-ids.ts` so the two cannot disagree about what ' +
        'the template looks like — they did, at two different tolerances, until a review ' +
        'measured it.'
    ).toBe(true);
  });
});
