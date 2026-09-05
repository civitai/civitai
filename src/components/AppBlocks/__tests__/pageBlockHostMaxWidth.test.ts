import fs from 'fs';
import path from 'path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * THE ULTRAWIDE CAP — the SOURCE half. (`PageBlockHostMaxWidth.browser.test.tsx`
 * is the MEASURED half. Neither half is a merge gate — see below.)
 *
 * A full-page App Block had no width bound anywhere in its chain (page wrapper,
 * host root and iframe are each `width: 100%`), so on a 2560px display an app
 * rendered as a single ~2500px column. `PageBlockHost` now reads
 * `max-width: var(--app-page-max-width, …)` with `margin-inline: auto`.
 *
 * 🔴 ON `app-page-content`, NOT ON THE HOST ROOT — the root is full-bleed so the app
 * CHROME spans the page like every other site-level bar, and only the app's own column
 * is capped. The opt-out ledger still keys on the ROOT and reaches the capped box by
 * INHERITANCE. That split is why two of the pins below are about the RELATIONSHIP
 * between the two elements rather than about either one alone: before it, the cap and
 * the ledger anchor were the same element and the older pins composed into the
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
 *   · the constant exists, once, inside a band this file states as LITERALS
 *   · `--app-page-max-width` exists, once, in globals.css, and agrees with it
 *   · the cap's two declarations, as one verbatim expression
 *   · the cap is on `app-page-content` and that box is INSIDE the frame — the
 *     relationship the ledger's inheritance depends on, which no older pin covers
 *   · the content wrapper's whole box model, because a dropped `flex: 1` collapses
 *     the app to a sliver with every test in BOTH tiers green (measured)
 *   · BOTH `data-app-page-frame` and `data-block-id` are stamped on the host root
 *     ELEMENT — the opt-out ledger's selector chains them, so a rename OR a move
 *     of either half onto another element makes every ledger rule match nothing
 *     without changing anything visible
 *
 *   · the value is read through `var()` and never written inline
 *
 * 🔴 WHAT IS **NOT** PINNED HERE, AND WHY. That the ledger's selector survives the
 * PRODUCTION compiler is a different claim, and this file cannot make it: it reads
 * source, not the build config. `next.config.mjs` strips `data-testid` from the DOM
 * under `NODE_ENV === 'production'`, so a ledger keyed on the testid ships in the
 * stylesheet and matches nothing live — which is exactly what happened, with this
 * file and the browser suite both green. That seam is owned by
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

/** Strip block + line comments so a rule can never be satisfied by prose ABOUT
 *  the rule — every token searched for below is also discussed at length in the
 *  comments of the file it is searched for in. */
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
        'it to locate the host ROOT and prove the capped content wrapper is inside it — the ' +
        "relationship the ledger's inheritance depends on. (The ledger itself selects on " +
        '`data-app-page-frame`, not on the testid, which production strips.) Re-point this ' +
        'guard only if the element was deliberately renamed.'
    ),
    content: one(
      'app-page-content',
      'no element in PageBlockHost.tsx carries `data-testid="app-page-content"`. If the cap ' +
        'moved back onto the host root, the app chrome is being capped along with the app ' +
        'again — the regression this change removed.'
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

describe('the full-page App Block host caps its width, and the cap is overridable', () => {
  /**
   * 🔴 THE BOUNDS ARE LITERALS HERE, DELIBERATELY NOT READ FROM THE SOURCE. A
   * band derived from `PageBlockHost.tsx` would be graded against the very file
   * it bounds, so one edit could move the value and its own limits together —
   * the self-referential trap `FILL_MIN_HEIGHT_PX` already records.
   *
   * Lower 1280: below this the cap would be narrower than the widest ORDINARY
   * civitai content measure (Mantine `xl`, 1320 border-box / 1288 content — also
   * `APPS_TWO_COLUMN_DETAIL_MEASURE`'s FLOOR, the store-preview page an app is
   * launched FROM), so an app would render narrower than the page that linked to it.
   *
   * ⚠️ THAT MEASURE IS A BAND NOW, `{min: 1288, max: 1600}`, and this comment used to
   * cite it as a single number. The lower bound is unaffected — it is keyed on the
   * floor — but the sibling claim in `PageBlockHost.tsx` that 1600 sits "above every
   * ordinary content measure on the site" is now PARITY rather than headroom: at the
   * top of that band the store-preview page and the app cap are the same width. The
   * conclusion holds, the margin does not, and both files say so.
   *
   * Upper 1920: the width `APPS_PAGE_CONTAINER_WIDTH` held when this band was
   * chosen. ⚠️ THAT CONSTANT IS NOW 2560 — the ultrawide pass moved it — and the
   * bound is deliberately NOT following it. 1920 is kept as the tighter, still-true
   * ceiling: the cap is 1600, nowhere near either number, and widening this bound to
   * track a container that exists for card grids and wide tables would weaken the
   * guard for no evidence. Re-deriving the cap from "the widest first-party surface"
   * is exactly the reasoning `PageBlockHost.tsx` now warns against, because that
   * surface has taken three VALUES over time (1600 → 1920 → 2560) without any of
   * those moves being a statement about third-party app width. Precisely:
   * `APPS_PAGE_CONTAINER_WIDTH` was introduced at 1920 (`a15d275759`) and has moved
   * ONCE, to 2560; the 1600 predates the constant.
   *
   * The ARITHMETIC that picks a value inside the band lives on the constant's own
   * doc comment; the NUMBERS live here.
   */
  it('`APP_PAGE_MAX_WIDTH_PX` is declared once and stays inside its documented band', () => {
    const declared = /export const APP_PAGE_MAX_WIDTH_PX = (\d+);/.exec(code(read(HOST)))?.[1];
    expect(
      declared,
      'APP_PAGE_MAX_WIDTH_PX declaration not found in PageBlockHost.tsx — if it was renamed or ' +
        'derived, re-point this guard rather than deleting it: it is the ONLY assertion anywhere ' +
        'that reads this declaration. The browser tier deliberately imports nothing from the ' +
        'host (it measures a rendered width instead), so deleting this leaves the constant and ' +
        'its band unchecked. It is not a merge gate — no status check is required on `main` — ' +
        'but it is the only thing that would say so.'
    ).toBeDefined();

    const cap = Number(declared);
    expect(cap).toBeGreaterThanOrEqual(1280);
    expect(cap).toBeLessThanOrEqual(1920);
  });

  /**
   * 🔴 CSS CANNOT IMPORT A TS CONSTANT, so the number exists twice and this is
   * the only thing keeping the two in step. Exactly the arrangement — and the
   * failure mode — that `--header-height` / `HEADER_HEIGHT_PX` has in
   * `pageRunScrollContract.test.ts`.
   *
   * The custom property is the LIVE value; the TS constant is the `var()`
   * fallback. So a divergence is not cosmetic: it means the cap that ships and
   * the cap the code claims are different numbers, and the fallback silently
   * takes over anywhere the app stylesheet is not loaded.
   */
  it('`--app-page-max-width` is declared once in shipped `src/`, in globals.css, and agrees with the constant', () => {
    const declared = /export const APP_PAGE_MAX_WIDTH_PX = (\d+);/.exec(code(read(HOST)))?.[1];
    expect(declared).toBeDefined();

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

    const decls: { file: string; value: string }[] = [];
    /** Declarations that sit under a `[data-block-id=…]` selector — the opt-out ledger. */
    const ledgerOverrides: { file: string; value: string }[] = [];
    for (const file of files) {
      // 🔴 TEST FILES ARE OUT OF SCOPE, AND THE CLAIM IS NARROWED TO MATCH —
      // this counts declarations in SHIPPED source, not every occurrence under
      // `src/`. Unlike the `--header-height` guard (which skips only itself),
      // this property's own coverage REQUIRES a test to declare it: the browser
      // suite proves the cap is really read from the custom property, and proves
      // the ledger's rule shape works, by injecting overrides of exactly this
      // form. Counting those as duplicates would make the guard forbid its own
      // evidence. A declaration inside a `*.test.*` file cannot reach a user, so
      // excluding them costs nothing the claim above needs.
      if (/\.test\.tsx?$/.test(file)) continue;
      const src = code(fs.readFileSync(file, 'utf8'));
      // Three spellings, matching the `--header-height` guard: plain CSS, the
      // CSS-in-JS object form (including a computed key), and the imperative
      // setter. The second is the one that would silently defeat the opt-out.
      const patterns = [
        /--app-page-max-width\s*:\s*([^;}\n]+)/g,
        /['"`]--app-page-max-width['"`]\s*\]?\s*:\s*([^,;}\n]+)/g,
        /setProperty\(\s*['"`]--app-page-max-width['"`]\s*,\s*([^)]+)\)/g,
      ];
      for (const re of patterns) {
        for (const m of src.matchAll(re)) {
          // 🔴 A LEDGER OVERRIDE IS NOT A DUPLICATE DEFAULT, and an earlier
          // version of this guard could not tell them apart — it counted every
          // declaration and demanded exactly one, so the FIRST real opt-out
          // entry would have failed it. That is a guard that forbids the feature
          // it is guarding, and it would have been discovered by whoever added
          // the entry rather than by whoever wrote the guard.
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
          };
          if (/\[data-block-id\s*[=~|^$*]?=/.test(selector)) ledgerOverrides.push(entry);
          else decls.push(entry);
        }
      }
    }

    expect(
      decls.map((d) => `${d.file}: ${d.value}`),
      'expected exactly ONE DEFAULT `--app-page-max-width` declaration in shipped src/ (test ' +
        'files excluded, and `[data-block-id=…]` ledger overrides excluded — those are the ' +
        'documented opt-out and are counted separately below). Zero means it was renamed, ' +
        'removed or commented out — the host then falls back to its inline literal and every ' +
        'ledger rule overrides a property nothing else sets. More than one means the DEFAULT cap ' +
        'is conditional or duplicated, and binding it to a single TS constant is no longer a ' +
        'truthful claim.'
    ).toHaveLength(1);
    expect(decls[0].file, 'the `--app-page-max-width` declaration moved out of globals.css').toBe(
      'src/styles/globals.css'
    );
    expect(
      decls[0].value,
      'globals.css `--app-page-max-width` and `APP_PAGE_MAX_WIDTH_PX` have DIVERGED (or the unit ' +
        'changed). The custom property is what actually ships; the constant is only the `var()` ' +
        'fallback, so a divergence means the code documents a cap the site does not use.'
    ).toBe(`${declared}px`);

    // Every ledger override must live in globals.css beside the default. A rule
    // of this shape in a CSS Module or a component stylesheet would work, but it
    // would put the opt-out somewhere no one reviewing the ledger would look.
    expect(
      [...new Set(ledgerOverrides.map((d) => d.file))],
      'a `[data-block-id=…]` override of `--app-page-max-width` was found outside globals.css. ' +
        'The full-bleed ledger is meant to be one reviewable list; an entry elsewhere is invisible ' +
        'to everyone reading it.'
    ).toEqual(ledgerOverrides.length === 0 ? [] : ['src/styles/globals.css']);
  });

  /**
   * 🔴 THE FULL-BLEED LEDGER IS A MEMBERSHIP LIST, AND BOTH DIRECTIONS ARE THE
   * POINT — it fails when the set GROWS (an app was excused from the cap without
   * anyone reading the criteria) and when it SHRINKS (an entry was dropped during
   * an unrelated change and an app that needs full bleed is quietly letterboxed
   * again). Modelled on the `fill` opt-in ledger in `pageRunScrollContract.test.ts`.
   *
   * 🔴 THE EXPECTATION IS AN ENUMERATION, NOT A FLOOR. It was `[]` when the
   * mechanism shipped, which is what forced the first entry to be argued for
   * rather than appended; `playable-collections` was then added by an explicit
   * product decision, with the reasoning recorded beside the rule in
   * `globals.css`. Adding a row here is the intended maintenance path — relaxing
   * this to a `toContain`, a length check or a superset test is not, and would
   * throw away the shrink half. A second entry must fail this test first.
   *
   * WHY EACH MEMBER IS HERE (keep this list in step with the rules):
   *   · `playable-collections` — a collection player whose three open-collection
   *     view modes are all uncapped by the app; the 960px well it does have
   *     applies only to its browse shell, behind an early return. Full reasoning
   *     and the file:line evidence live on the rule in `globals.css`.
   *
   * The ids are read from the SELECTORS, not from a hand-kept list elsewhere, so
   * a rule nobody told this test about is what it notices. `code()` strips
   * comments first, so the template rule inside the ledger's own doc comment is
   * not a member.
   */
  it('the full-bleed opt-out ledger — membership is explicit, and fails on growth AND shrink', () => {
    const css = code(read(GLOBALS_CSS));
    const members = [...css.matchAll(/\[data-block-id\s*=\s*['"]([^'"]+)['"]\]/g)]
      .map((m) => m[1])
      .sort();

    expect(
      members,
      'the full-bleed opt-out ledger in src/styles/globals.css has changed. If you ADDED an ' +
        'entry, add its block id to this expectation in the same commit, and make sure the ' +
        "id is the app's `app_blocks.block_id` (what `PageBlockHost` stamps as `data-block-id`) " +
        'rather than a listing slug — for an on-site app they are identical by construction ' +
        '(`app-listing-mapper.ts` sets `slug: ab.blockId`), which is exactly the condition under ' +
        'which the wrong one goes unnoticed. If you REMOVED one, an app that needed full bleed is ' +
        'now capped again — confirm that is intended.'
    ).toEqual(['playable-collections']);
  });

  /**
   * 🔴 PIN THE WHOLE EXPRESSION, NOT FEATURES OF IT — the lesson
   * `pageRunScrollContract.test.ts` paid for. A presence check on the token
   * `maxWidth` survives every mutation that matters here:
   *
   *   · dropping `marginInline: 'auto'` — the app is still capped, but the whole
   *     gutter lands on the right and it reads as a rendering bug
   *   · dropping the `var()` and hardcoding the number — the two tests above
   *     still pass and every CSS opt-out silently stops working
   *   · dropping the fallback — the cap disappears wherever globals.css is absent
   *
   * The accepted cost is that a cosmetic reformat of this exact pair fails this
   * test. That is the trade for a machine-checkable claim, and `code()` runs
   * first, so commenting a line out changes the string exactly as deleting it does.
   */
  it("pins the host's cap declarations verbatim — a dropped `auto` margin, `var()` or fallback all fail", () => {
    const src = code(read(HOST));
    expect(
      region(src, /maxWidth: `var\(--app-page-max-width[\s\S]*?marginInline: 'auto',/, 'width cap'),
      'This is a DELIBERATE verbatim pin, not an incidental string match. If you changed this ' +
        'pair on purpose (including a pure reformat), update the expected string here in the ' +
        'same commit. If you did not, you have either uncentred the app, hardcoded the cap past ' +
        'its own opt-out, or removed the fallback that caps a host rendered without globals.css.'
    ).toBe(
      "maxWidth: `var(--app-page-max-width, ${APP_PAGE_MAX_WIDTH_PX}px)`, marginInline: 'auto',"
    );
  });

  /**
   * 🔴 THE CAP AND THE CHROME ARE ON DIFFERENT ELEMENTS NOW, AND UNTIL THIS GUARD
   * EXISTED THE NODE TIER COULD NOT SEE THAT AT ALL.
   *
   * The cap used to sit on the host root, so the two guards above — "the cap pair
   * appears verbatim somewhere" and "`data-block-id` is on the frame" — described
   * the SAME element and together implied the mechanism. Moving the cap down to
   * `app-page-content` broke that composition silently: each guard still passes
   * while describing a different element, and nothing asserts the capped box is a
   * DESCENDANT of the frame — which is exactly the relationship the full-bleed
   * ledger now depends on, since the custom property is set on the frame and read
   * one level down.
   *
   * Measured by mutation, in a copy: reverting the whole change (cap back on the
   * frame, chrome capped again) left the FULL node suite — 1569 files, 24,879 tests
   * — byte-identically green. Only the browser tier caught it, and that tier is
   * report-only everywhere. This test is the node-tier half — the one that renders
   * an honest verdict on a push to `main` or a `workflow_dispatch` (neither tier
   * blocks a merge; see the header).
   */
  it('the cap sits on `app-page-content`, and that box is a real DESCENDANT of the frame', () => {
    const { frame, content } = hostElements();

    // 🔴 CONTAINMENT IS ASSERTED ON THE PARSE TREE, NOT BY COMPARING TEXT OFFSETS, AND
    // THE DIFFERENCE IS THE ENTIRE VALUE OF THIS TEST. An earlier version asked whether
    // `app-page-content` appeared LATER IN THE FILE than `app-page-frame` — which every
    // sibling, cousin and unrelated later element also satisfies. Measured on that
    // version: closing the frame before the content box, so the two are genuine SIBLINGS
    // and the ledger's inheritance is dead, left this file 9/9 green AND the whole
    // node suite (1569 files / 24,879 tests) byte-identically green, while the
    // report-only browser tier correctly failed BOTH ledger tests. A guard whose message
    // says "no longer renders inside" must actually mean inside.
    expect(
      isDescendant(frame, content),
      '`app-page-content` is no longer a DESCENDANT of `app-page-frame`. The full-bleed ' +
        'opt-out ledger sets `--app-page-max-width` ON THE FRAME and relies on CSS ' +
        'INHERITANCE to reach the capped box, so lifting that box out from under the ' +
        'frame — even into a sibling that still renders — makes every ledger entry ' +
        'silently inert. This node tier renders nothing, so this source-level ' +
        'containment check is its only view of the relationship; the only tier that ' +
        'can observe it at runtime is the report-only browser tier.'
    ).toBe(true);

    // The cap must live in the CONTENT element's style prop, not the FRAME's.
    //
    // 🔴 READ OFF THE ELEMENT'S OWN `style` ATTRIBUTE, NOT A TEXT SLICE BETWEEN THE TWO
    // TESTIDS. Two successive text-based attempts were each defeated by where the
    // characters happened to fall: the first started at the frame's `data-testid` and so
    // began AFTER its `style={{…}}` (JSX orders them that way), and the second anchored on
    // `lastIndexOf('<', …)`, which finds the nearest preceding `<` — the opening tag only
    // while nothing in the element's own props contains one. Measured: inserting an
    // ordinary prop holding a `<` before the testid re-opened the hole and the
    // cap-back-on-the-frame mutant passed this test again. The attribute's own text has no
    // such ambiguity.
    expect(
      readableStyleOf(frame, 'app-page-frame'),
      'the `max-width` cap is declared on the host FRAME again. That re-caps the app chrome ' +
        'along with the app — a full-page app then renders as a boxed widget dropped into ' +
        'the page rather than as a page of the site.'
    ).not.toContain('--app-page-max-width');
    expect(
      readableStyleOf(content, 'app-page-content'),
      'the `max-width` cap is no longer declared on `app-page-content`. If it moved, this ' +
        "guard and the ledger's inheritance both need re-deriving."
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
    expect(
      norm(readableStyleOf(content, 'app-page-content')),
      "This is a DELIBERATE verbatim pin of `app-page-content`'s box model. `flex: 1` is " +
        'what makes this box consume the height the chrome left; without it the app column ' +
        'collapses to its content-based minimum and NO rendered test in either tier ' +
        'notices. If you changed this block on purpose, update the expected string here in ' +
        'the same commit.'
    ).toBe(
      "{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, width: '100%', " +
        'maxWidth: `var(--app-page-max-width, ${APP_PAGE_MAX_WIDTH_PX}px)`, ' +
        "marginInline: 'auto', }"
    );
  });

  /**
   * 🔴 THE OPT-OUT'S SELECTOR IS A RELATIONSHIP BETWEEN TWO ATTRIBUTES ON ONE
   * ELEMENT, so that is what is asserted — not that each token appears somewhere
   * in the file.
   *
   * The ledger in globals.css is written as
   * `[data-app-page-frame][data-block-id='…']`. If `data-block-id` moves to a
   * different element, or is renamed, or is fed the per-install
   * `blockInstanceId` instead of the app's slug, every ledger rule matches
   * nothing — and nothing about the page looks wrong, so no one finds out until
   * an app that opted out is reported as still capped.
   *
   * The testid is only this guard's ANCHOR for finding the root element; the
   * ledger no longer selects on it (production strips it).
   *
   * 🔴 BOTH HALVES, ON THE PARSED FRAME ELEMENT — NOT A TEXT SEARCH OVER THE FILE.
   * `data-app-page-frame` was added by the fix that re-keyed the ledger, and it
   * was originally pinned only by a whole-file substring search in
   * `ledgerSelectorSurvivesProdStrip.test.ts`. Measured: moving that attribute off
   * the host root onto the `app-page-content` wrapper — which re-creates the
   * shipped production defect exactly, since the compound selector then matches
   * zero elements — left the ENTIRE node tier byte-identically green
   * (`7 failed | 741 passed`, the same pre-existing failures, both ways). Only the
   * report-only browser tier caught it. Asking `hostElements()` for the frame and
   * reading ITS attribute list is what makes "on the root" a checkable claim.
   */
  it('stamps BOTH ledger attributes on the host root — the opt-out selector chains them', () => {
    const { frame } = hostElements();
    const attrs = frame.attributes.properties.filter(ts.isJsxAttribute);
    const names = attrs.map((a) => a.name.getText());

    expect(
      names,
      'the host ROOT no longer stamps `data-app-page-frame`. The full-bleed ledger in ' +
        "src/styles/globals.css selects on `[data-app-page-frame][data-block-id='…']` — a " +
        'compound selector, so BOTH halves must be on the SAME element. `data-testid` cannot ' +
        'stand in for it: `next.config.mjs` strips every testid from the production DOM, which ' +
        'is the defect that made this attribute necessary. Moving it to the content wrapper ' +
        'reads as a tidy-up and makes every ledger entry match nothing, with nothing visibly wrong.'
    ).toContain('data-app-page-frame');

    expect(
      names,
      'the host root no longer stamps `data-block-id`. The full-bleed ledger selects on ' +
        "`[data-app-page-frame][data-block-id='…']`, so every entry in it is now inert."
    ).toContain('data-block-id');

    const blockIdAttr = attrs.find((a) => a.name.getText() === 'data-block-id');
    expect(
      norm(blockIdAttr!.getText()),
      'the host root stamps `data-block-id` from something other than `blockId`. `blockId` (the ' +
        'app slug, what builds `<slug>.civit.ai`) is the required value — `blockInstanceId` is ' +
        'per-install and is NOT what an app author knows their app by, so a ledger entry written ' +
        'against the slug would match nothing.'
    ).toBe('data-block-id={blockId}');
  });

  /**
   * ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — this passes on the base
   * revision too (where neither the property nor the cap existed), and is
   * labelled so it is never counted as proof the cap works.
   *
   * What it protects is the opt-out's ONE structural precondition. An inline
   * `style={{ '--app-page-max-width': … }}` on the host root would look like a
   * tidier way to spell the same thing and would render identically — but an
   * inline custom property beats every stylesheet rule on that element, which is
   * exactly the rule shape the ledger uses. The opt-out would become inert with
   * no visible change anywhere.
   */
  it('INVARIANT — the cap is never written as an inline custom property, which would beat the ledger', () => {
    const src = code(read(HOST));
    expect(
      /['"`]--app-page-max-width['"`]\s*\]?\s*:/.test(src),
      'PageBlockHost.tsx now sets `--app-page-max-width` as an inline style property. An inline ' +
        'custom property wins over any stylesheet rule targeting the same element, so this makes ' +
        'the full-bleed ledger in globals.css inert while rendering identically. Read the ' +
        'property with `var()`; declare it in globals.css.'
    ).toBe(false);
  });

  /**
   * The ledger itself has to keep selecting the element the host renders. This
   * asserts the two halves of that selector are the ones globals.css names —
   * a rename on either side is caught by whichever guard sees it first.
   */
  it('globals.css documents the opt-out against the attributes the host actually stamps', () => {
    const css = read(GLOBALS_CSS);
    expect(
      css,
      'src/styles/globals.css no longer documents the full-bleed opt-out against ' +
        '`data-block-id`. The ledger is the ONLY way out of the cap; if it stops naming the ' +
        'attribute the host stamps, an app author following it writes a rule that matches nothing.'
    ).toContain('data-block-id');
  });
});
