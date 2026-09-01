import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * THE ULTRAWIDE CAP — the GATING half.
 *
 * A full-page App Block had no width bound anywhere in its chain (page wrapper,
 * host root and iframe are each `width: 100%`), so on a 2560px display an app
 * rendered as a single ~2500px column. `PageBlockHost` now reads
 * `max-width: var(--app-page-max-width, …)` with `margin-inline: auto` on its
 * root.
 *
 * 🔴 WHY A SOURCE GUARD AS WELL AS A RENDERED ONE. The measurement lives in
 * `PageBlockHostMaxWidth.browser.test.tsx`, which is the only tier that can see a
 * width at all — but the browser `component` project runs in CI as the
 * REPORT-ONLY `preview / component-tests` status, so nothing there can block a
 * merge. This file is in the node `unit` project, which can. The same split, and
 * the same reasoning, as `pageRunScrollContract.test.ts` (whose own header
 * records the measured case where a fully-reverted floor left the gating tier
 * 9/9 green and only the non-blocking tier red).
 *
 * WHAT IS PINNED HERE, and each is a thing whose absence is silent:
 *   1. the constant exists, once, inside a band this file states as LITERALS
 *   2. `--app-page-max-width` exists, once, in globals.css, and agrees with it
 *   3. the host's two declarations, as one verbatim expression
 *   4. `data-block-id` is stamped on the SAME element as the host testid — the
 *      opt-out ledger's selector chains the two, so a rename makes every ledger
 *      rule match nothing without changing anything visible
 *   5. the value is read through `var()` and never written inline
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

describe('the full-page App Block host caps its width, and the cap is overridable', () => {
  /**
   * 🔴 THE BOUNDS ARE LITERALS HERE, DELIBERATELY NOT READ FROM THE SOURCE. A
   * band derived from `PageBlockHost.tsx` would be graded against the very file
   * it bounds, so one edit could move the value and its own limits together —
   * the self-referential trap `FILL_MIN_HEIGHT_PX` already records.
   *
   * Lower 1280: below this the cap would be narrower than the widest ORDINARY
   * civitai content measure (Mantine `xl`, 1320 border-box / 1288 content — also
   * `APPS_TWO_COLUMN_DETAIL_MEASURE`, the store-preview page an app is launched
   * FROM), so an app would render narrower than the page that linked to it.
   *
   * Upper 1920: `APPS_PAGE_CONTAINER_WIDTH`, the widest first-party surface on
   * the site, and it is that wide for card grids and wide tables specifically. At
   * or above it the cap stops binding at the sizes that motivated it.
   *
   * The ARITHMETIC that picks a value inside the band lives on the constant's own
   * doc comment; the NUMBERS live here.
   */
  it('`APP_PAGE_MAX_WIDTH_PX` is declared once and stays inside its documented band', () => {
    const declared = /export const APP_PAGE_MAX_WIDTH_PX = (\d+);/.exec(code(read(HOST)))?.[1];
    expect(
      declared,
      'APP_PAGE_MAX_WIDTH_PX declaration not found in PageBlockHost.tsx — if it was renamed or ' +
        'derived, re-point this guard rather than deleting it: it is the only BLOCKING check on ' +
        'the ultrawide cap.'
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
   * 🔴 IT IS EMPTY TODAY, AND THAT IS A REAL ASSERTION, NOT A PLACEHOLDER. An
   * empty expectation is exactly what makes the FIRST entry a deliberate,
   * reviewed act: adding a rule to globals.css fails this test until someone
   * writes the block id here too, with a reason. Adding a row is the intended
   * maintenance path — deleting the assertion is not.
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
    ).toEqual([]);
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
   * 🔴 THE OPT-OUT'S SELECTOR IS A RELATIONSHIP BETWEEN TWO ATTRIBUTES ON ONE
   * ELEMENT, so that is what is asserted — not that each token appears somewhere
   * in the file.
   *
   * The ledger in globals.css is written as
   * `[data-testid='app-page-frame'][data-block-id='…']`. If `data-block-id` moves
   * to a different element, or is renamed, or is fed the per-install
   * `blockInstanceId` instead of the app's slug, every ledger rule matches
   * nothing — and nothing about the page looks wrong, so no one finds out until
   * an app that opted out is reported as still capped.
   */
  it('stamps `data-block-id` on the same element as the host testid — the opt-out ledger keys on both', () => {
    const src = code(read(HOST));
    const root = region(
      src,
      /data-testid="app-page-frame"[\s\S]*?data-needs-consent=/,
      'host root attributes'
    );
    expect(
      root,
      'the host root no longer stamps `data-block-id={blockId}` between its testid and ' +
        '`data-needs-consent`. The full-bleed ledger in src/styles/globals.css selects on ' +
        "`[data-testid='app-page-frame'][data-block-id='…']`, so every entry in it is now " +
        'inert. `blockId` (the app slug) is the required value — `blockInstanceId` is per-install ' +
        'and is NOT what an app author knows their app by.'
    ).toContain('data-block-id={blockId}');
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
