import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SEAM GATE — the screenshot gallery's "an unpaired tile fills the row" rule and
 * the `className` that activates it must both exist, and must agree.
 *
 * WHY THIS IS A SEAM AND NOT TWO CHECKS. The fix is one CSS rule
 * (`AppListingDetailBody.module.scss` → `.gallery > :last-child:nth-child(odd) {
 * grid-column: 1 / -1 }`) plus one `className={galleryClasses.gallery}` on the
 * gallery's `SimpleGrid`. Either half alone is INERT AND SILENT: a stylesheet whose
 * class nothing references changes no pixels, and a `className` naming a class the
 * stylesheet no longer declares resolves to `undefined`, renders no attribute, and
 * throws nothing. Neither shows up as an error anywhere — the page just quietly goes
 * back to rendering a single screenshot at half the column, which is the defect this
 * change exists to fix. So the checkable claim is the RELATIONSHIP, and it is checked
 * in BOTH directions.
 *
 * 🔴 WHY IT IS IN THE NODE `unit` PROJECT AND WHAT IT IS NOT. The real proof lives in
 * `AppListingDetailBody.gallery.browser.test.tsx`, which renders the page in Chromium
 * with Mantine's stylesheet loaded and MEASURES the tiles. But that file is in the
 * browser-mode `component` project, which CI runs only as the preview pipeline's
 * `preview / component-tests` — report-only, non-blocking, and not reported at all
 * when the preview build fails. So the geometry claim cannot gate anything, and this
 * file is what does. It is a SOURCE-TEXT gate, with the honesty that implies:
 *
 *   - CAUGHT: deleting the rule from the stylesheet; deleting the stylesheet import;
 *     dropping `className` from the grid; renaming the class on one side only;
 *     changing `1 / -1` to a hard-coded `span 2` (which is wrong on the one-track
 *     mobile layout); moving the gallery to a plain `SimpleGrid` with no class.
 *   - NOT CAUGHT: a rule that is present but overridden by later CSS, a `SimpleGrid`
 *     replaced by something that is not `display: grid`, or any change to what the
 *     rule renders as. Those are pixel facts and only the browser tier can see them.
 *
 * The repo already uses source-level unit gates for exactly this shape of invariant —
 * see the `no raw <iframe>` gate in `appListingDetailView.test.ts` and the
 * `AppBlockChrome is actually WIRED` block in `recentAppsRail.test.ts`.
 */
describe('🔴 the screenshot gallery fill rule is declared AND wired', () => {
  const STYLES = path.resolve(__dirname, '../AppListingDetailBody.module.scss');
  const SOURCE = path.resolve(__dirname, '../AppListingDetailBody.tsx');

  /**
   * Strip SCSS/JS comments. Load-bearing rather than tidy: BOTH files document this
   * rule in prose that names the selector and the `1 / -1` value verbatim, so an
   * unstripped match would be reading the DOCSTRING and would stay green with the
   * real declaration deleted — the exact way a gate becomes decorative.
   */
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** Collapse whitespace so the matchers below are indentation- and newline-agnostic. */
  const norm = (s: string) => s.replace(/\s+/g, ' ');

  /**
   * The fill rule: a `>`-combined `:last-child:nth-child(odd)` whose block sets
   * `grid-column` to `1 / -1`.
   *
   * 🔴 `1 / -1` IS REQUIRED, `span 2` IS NOT ACCEPTED, and that is a decision rather
   * than pedantry. The gallery is ONE track below Mantine's `sm` breakpoint and two
   * above it; `span 2` on the one-track layout asks for a track that does not exist,
   * so the browser implicitly creates a second column and the tile ends up half the
   * width of the phone. `1 / -1` is the only form correct at both track counts.
   */
  const FILL_RULE =
    />\s*:last-child:nth-child\(\s*odd\s*\)\s*\{[^}]*grid-column:\s*1\s*\/\s*-1\s*;/;

  /** The class must be declared as a top-level `.gallery { … }` block in the module. */
  const CLASS_DECL = /\.gallery\s*\{/;

  const WHY_STYLES =
    'The screenshot gallery fill rule is gone from AppListingDetailBody.module.scss. ' +
    'Without `.gallery > :last-child:nth-child(odd) { grid-column: 1 / -1 }` a listing ' +
    'with ONE screenshot renders it at half the main column with dead space beside it, ' +
    'and so does the trailing tile of any odd count. The rule is written as a ' +
    'structural selector on purpose: a tile is dropped on a load error, so ' +
    'the rendered tile count is not screenshots.length and cannot be computed before ' +
    'render. See the stylesheet header.';

  const WHY_WIRING =
    'AppListingDetailBody.tsx no longer applies the gallery fill class to the ' +
    'screenshot SimpleGrid. The stylesheet rule is inert without it — nothing errors, ' +
    'the gallery just goes back to leaving half the column empty for a single ' +
    'screenshot. Re-add className={galleryClasses.gallery} to the grid in ' +
    'ScreenshotGallery.';

  /**
   * The `ScreenshotGallery` function body — sliced from its declaration to the start
   * of the next TOP-LEVEL declaration. Every other `SimpleGrid` in the file (there are
   * none today, which is precisely why this must not rely on that staying true) is
   * excluded, so the wiring assertion is about THIS grid and not about any grid.
   *
   * 🔴 THE OBVIOUS SLICER IS WRONG HERE, MEASURED RATHER THAN REASONED. "Cut at the
   * next column-0 `}`" is the natural implementation and it truncates this function
   * after its FIRST LINE, because a multi-line destructured signature closes with a
   * column-0 `}` of its own (`}: {`). It returned `'function ScreenshotGallery({
   * screenshots, name, }'` — a non-empty string, so the `!== ''` guard passed — and
   * the wiring assertion then failed for a reason that had nothing to do with the
   * wiring. That failure was LOUD; the mirror image would not have been. The fixture
   * in the control below carries that exact signature shape so this cannot come back.
   */
  const screenshotGalleryBody = (src: string) => {
    const start = src.indexOf('function ScreenshotGallery(');
    if (start < 0) return '';
    const after = src.slice(start + 1);
    const next = after.search(/\n(?:function |const |export |\/\*\*)/);
    return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
  };

  it('every matcher can SEE its target and can MISS a mutated one (positive control)', () => {
    // 🔴 Each matcher is driven through a fixture whose answer is known, in BOTH
    // directions. A `toMatch` that can never match, or a `not.toMatch` over a regex
    // wired to nothing, is a green that means nothing — and every assertion in this
    // file is one of those two shapes.

    // FILL_RULE sees the real shape…
    expect(norm('.gallery { > :last-child:nth-child(odd) { grid-column: 1 / -1; } }')).toMatch(
      FILL_RULE
    );
    // …tolerates the whitespace the author might use…
    expect(norm('.g {\n  > :last-child:nth-child( odd ) {\n grid-column:1/-1;\n }\n}')).toMatch(
      FILL_RULE
    );
    // …and MISSES the three mutations that would silently reinstate the defect:
    // the rule deleted outright,
    expect(norm('.gallery { gap: 16px; }')).not.toMatch(FILL_RULE);
    // the selector narrowed so a lone tile (which is also `:first-child`) is the only
    // one it catches — leaving the odd-trailing case broken,
    expect(norm('.gallery { > :only-child { grid-column: 1 / -1; } }')).not.toMatch(FILL_RULE);
    // and the value swapped for the track-count-dependent `span 2`.
    expect(norm('.gallery { > :last-child:nth-child(odd) { grid-column: span 2; } }')).not.toMatch(
      FILL_RULE
    );

    // The comment stripper must remove ENOUGH — both files' prose names the selector
    // and the value verbatim, so this is what stops the docstring satisfying the gate…
    const docOnly = '/* .gallery > :last-child:nth-child(odd) { grid-column: 1 / -1; } */\n';
    expect(norm(docOnly)).toMatch(FILL_RULE);
    expect(norm(stripComments(docOnly))).not.toMatch(FILL_RULE);
    // …and must NOT remove too much, or every `not.toMatch` below passes vacuously
    // against an empty string. (`stripComments = () => ''` satisfies every assertion
    // above this line.)
    expect(stripComments('.gallery { color: red; }')).toContain('.gallery { color: red; }');

    // The body slicer really isolates a function, and returns '' rather than the whole
    // file when the function is gone (so a rename fails LOUDLY at the assertion below
    // instead of silently matching some other component's grid).
    //
    // 🔴 THE FIXTURE CARRIES THE REAL SIGNATURE SHAPE — a MULTI-LINE DESTRUCTURED
    // parameter list whose closing `}: {` sits at column 0 — and that is the whole
    // reason it is written this way. A slicer that cuts at "the next column-0 `}`"
    // reads plausibly, passes a fixture with a one-line signature, and truncates the
    // real function after its first line. Measured on this very file.
    const fake =
      'function Other() {\n  return <SimpleGrid className={x.gallery} />;\n}\n' +
      'function ScreenshotGallery({\n  screenshots,\n  name,\n}: {\n' +
      '  screenshots: S[];\n  name: string;\n}) {\n  return <SimpleGrid cols={2} />;\n}\n' +
      'function After() {\n  return null;\n}\n';
    expect(screenshotGalleryBody(fake)).toContain('cols={2}');
    expect(screenshotGalleryBody(fake)).not.toContain('className={x.gallery}');
    expect(screenshotGalleryBody(fake)).not.toContain('function After');
    expect(screenshotGalleryBody('function Nope() {}\n')).toBe('');
  });

  it('🔴 the stylesheet declares .gallery and the unpaired-tile fill rule', () => {
    const css = norm(stripComments(fs.readFileSync(STYLES, 'utf8')));
    expect(css, WHY_STYLES).toMatch(CLASS_DECL);
    expect(css, WHY_STYLES).toMatch(FILL_RULE);
  });

  it('🔴 ScreenshotGallery imports that stylesheet and applies .gallery to its grid', () => {
    const raw = fs.readFileSync(SOURCE, 'utf8');
    const src = stripComments(raw);

    // (a) the module is imported at all, under a binding we can then look for…
    const importMatch = src.match(
      /import\s+(\w+)\s+from\s+'~\/components\/Apps\/AppListingDetailBody\.module\.scss'/
    );
    expect(importMatch, WHY_WIRING).not.toBeNull();
    const binding = importMatch![1];

    // (b) …and THAT binding's `.gallery` is applied inside ScreenshotGallery, on the
    // same element that declares the grid. Scoped to the function body so this cannot
    // be satisfied by an unrelated element elsewhere in the file.
    const body = norm(screenshotGalleryBody(src));
    expect(body, WHY_WIRING).not.toBe('');
    expect(body, WHY_WIRING).toContain('<SimpleGrid');
    expect(body, WHY_WIRING).toContain(`className={${binding}.gallery}`);
  });

  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — it was green before this change and
   * could not have caught the defect. It is here because the fix's whole premise is
   * that the tile count is a DOM fact rather than an array fact, and the single most
   * tempting "simplification" of this change is to compute `cols` from `shots.length`.
   * That reads as the same fix and is not: it fires on the array, so a 2-shot listing
   * whose first image 404s still renders its survivor at half width, and it does
   * nothing at all for the odd-trailing case (3 shots → the 3rd still gets one track).
   */
  it('🔴 the gallery derives no column count from the screenshot array (invariant guard)', () => {
    // Positive control FIRST: the matcher must be able to see such a thing, or the
    // absence assertion is a zero from a regex wired to nothing.
    const planted = 'cols={{ base: 1, sm: shots.length === 1 ? 1 : 2 }}';
    expect(planted).toMatch(/cols=\{[^}]*shots\b/);
    expect(planted).toMatch(/shots\.length/);

    const body = norm(screenshotGalleryBody(stripComments(fs.readFileSync(SOURCE, 'utf8'))));
    expect(
      body,
      'ScreenshotGallery is computing its column count from the screenshots array. ' +
        'a tile is DROPPED on a load error, so that number is not the number ' +
        'of tiles the browser ends up with — the fill rule is a CSS structural selector ' +
        'precisely so it does not have to know. See the stylesheet header.'
    ).not.toMatch(/cols=\{[^}]*shots\b/);
    // …including via a hoisted local, which the `cols={…}` shape above would miss.
    // `shots.length` legitimately appears ONCE, in the section-hiding early return.
    expect([...body.matchAll(/shots\.length/g)]).toHaveLength(1);
  });
});
