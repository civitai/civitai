import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔴 SEAM GATE — the screenshot GRID and the screenshot VIEWER must stay one feature.
 *
 * WHY A SEAM AND NOT TWO CHECKS. The viewer's arithmetic is pinned in the blocking
 * node project (`appListingScreenshotNav.test.ts`) and its rendered behaviour is
 * pinned in the browser project (`AppListingDetailBody.viewer.browser.test.tsx`).
 * Both can be fully green while the FEATURE is broken, because neither of them owns
 * the join: the grid decides which shots exist and which index a tile represents, and
 * the viewer navigates over that same list. If those two stop reading the SAME
 * bindings — a viewer handed the raw `screenshots` prop instead of the filtered
 * `shots`, or handed its own broken set instead of the gallery's — every existing
 * test still passes and the page opens the wrong picture the moment a URL dangles.
 * The relationship is the checkable claim, so it is checked here.
 *
 * 🔴 AND WHY IN THE **node** PROJECT. The browser suite that measures this for real
 * runs only as the preview pipeline's `preview / component-tests` — report-only,
 * non-blocking, and not reported at all when the preview build fails. A guard that
 * lives only there cannot stop the regression coming back. This file is source TEXT,
 * with the honesty that implies:
 *
 *   - CAUGHT: the viewer being dropped from the gallery; it being handed a different
 *     list or a different broken set than the grid uses; the tile losing its
 *     `onOpen` / `onBroken` / `index` wiring; the tile reverting to a non-button
 *     click target; `trapFocus` / `closeOnEscape` being switched OFF; either half of
 *     the `Modal.Stack` seam going missing from either host; and either half of the
 *     `returnFocus={false}` + `useOpenerFocusReturn` pair.
 *   - NOT CAUGHT: an off-by-one inside either component, a control wired to the wrong
 *     direction, or anything about what is actually rendered. Those are behaviour and
 *     belong to the other two files.
 *
 * Same shape and same rationale as `appListingGalleryFill.test.ts` next door.
 */
describe('🔴 the screenshot viewer is WIRED to the gallery that owns the list', () => {
  const BODY = path.resolve(__dirname, '../AppListingDetailBody.tsx');
  const VIEWER = path.resolve(__dirname, '../AppListingScreenshotViewer.tsx');

  /**
   * Strip block and line comments. Load-bearing rather than tidy: BOTH files document
   * this wiring in prose that names the props verbatim, so an unstripped match would
   * be reading the DOCSTRING and would stay green with the real code deleted — the
   * exact way a source gate becomes decorative.
   */
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  /** Collapse whitespace so every matcher is indentation- and newline-agnostic. */
  const norm = (s: string) => s.replace(/\s+/g, ' ');

  /**
   * A named function's body, sliced from its declaration to the start of the next
   * TOP-LEVEL declaration.
   *
   * 🔴 THE OBVIOUS SLICER IS WRONG — "cut at the next column-0 `}`" truncates these
   * functions after their first line, because a multi-line destructured signature
   * closes with a column-0 `}: {` of its own. That is not hypothetical: it happened
   * in this directory (see `appListingGalleryFill.test.ts`'s note), and the control
   * below carries that exact signature shape so it cannot come back.
   */
  const fnBody = (src: string, name: string) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) return '';
    const after = src.slice(start + 1);
    const next = after.search(/\n(?:function |const |export |\/\*\*)/);
    return next < 0 ? src.slice(start) : src.slice(start, start + 1 + next);
  };

  const bodySrc = () => stripComments(fs.readFileSync(BODY, 'utf8'));
  const viewerSrc = () => stripComments(fs.readFileSync(VIEWER, 'utf8'));

  it('every matcher can SEE its target and MISS a mutated one (positive control)', () => {
    // 🔴 Each assertion in this file is a `toContain` or a `not.toContain`. A
    // `toContain` that can never match, and a `not.toContain` over a needle nothing
    // could ever spell, are both greens that mean nothing — so both directions are
    // driven through a fixture whose answer is known.

    // The slicer really isolates ONE function, returns '' when it is gone (so a
    // rename fails loudly rather than silently matching a neighbour), and survives a
    // multi-line destructured signature.
    const fake =
      'function Other() {\n  return <AppListingScreenshotViewer shots={x} />;\n}\n' +
      'function ScreenshotGallery({\n  screenshots,\n  name,\n}: {\n' +
      '  screenshots: S[];\n  name: string;\n}) {\n  return <SimpleGrid cols={2} />;\n}\n' +
      'function After() {\n  return null;\n}\n';
    expect(fnBody(fake, 'ScreenshotGallery')).toContain('cols={2}');
    expect(fnBody(fake, 'ScreenshotGallery')).not.toContain('AppListingScreenshotViewer');
    expect(fnBody(fake, 'ScreenshotGallery')).not.toContain('function After');
    expect(fnBody('function Nope() {}\n', 'ScreenshotGallery')).toBe('');

    // The comment stripper removes ENOUGH — both real files name these props in
    // prose — and NOT TOO MUCH, or every `not.toContain` below passes vacuously
    // against an empty string (`stripComments = () => ''` satisfies them all).
    const docOnly = '/* it passes broken={broken} to the viewer */\n';
    expect(norm(docOnly)).toContain('broken={broken}');
    expect(norm(stripComments(docOnly))).not.toContain('broken={broken}');
    expect(stripComments('const a = 1;')).toContain('const a = 1;');
  });

  const WHY_SEAM =
    'ScreenshotGallery no longer mounts AppListingScreenshotViewer, or no longer ' +
    'hands it the SAME `shots` list and `broken` set the grid itself renders from. ' +
    'Those two bindings ARE the shared index space — a viewer reading a different ' +
    'list opens a different screenshot than the tile the viewer clicked, and every ' +
    'other test in this feature stays green while it does. See the header of ' +
    'appListingScreenshotNav.ts.';

  it('🔴 ScreenshotGallery mounts the viewer and shares its list and broken set', () => {
    const body = norm(fnBody(bodySrc(), 'ScreenshotGallery'));
    expect(body, WHY_SEAM).not.toBe('');

    // The seam exists…
    expect(body, WHY_SEAM).toContain('<AppListingScreenshotViewer');
    // …and is fed the very bindings the grid is built from. `shots` is what the grid
    // maps over; `broken` is what it filters by. Passing anything else here is how
    // the two surfaces silently disagree.
    expect(body, WHY_SEAM).toContain('shots={shots}');
    expect(body, WHY_SEAM).toContain('broken={broken}');
    expect(body, WHY_SEAM).toContain('index={openIndex}');

    // 🔴 …and the grid is genuinely built from those same two, so the assertions
    // above are about a SHARED binding rather than about two same-named locals.
    expect(body, WHY_SEAM).toContain('shots .map((shot, index) => ({ shot, index }))');
    expect(body, WHY_SEAM).toContain('!broken.has(index)');
  });

  const WHY_TILE =
    'A screenshot tile is no longer wired to open the viewer, or no longer reports ' +
    'its load error upward. `onBroken` is not optional politeness: the gallery owns ' +
    'the broken set precisely so the viewer skips the same shots the grid dropped, ' +
    'and a tile that keeps that fact to itself puts the two back out of step.';

  it('🔴 each tile carries its index, its open handler and its broken reporter', () => {
    const body = norm(fnBody(bodySrc(), 'ScreenshotGallery'));
    expect(body, WHY_TILE).toContain('<ScreenshotTile');
    expect(body, WHY_TILE).toContain('index={index}');
    // The tile opens ITS OWN index — the whole index-space claim in one line.
    expect(body, WHY_TILE).toContain('setOpenIndex(index)');
    expect(body, WHY_TILE).toContain('onBroken={() => markBroken(index)}');
    // …and records itself as the tile an ancestor focus trap should return to. Without
    // this the nested close lands on the review modal's chrome; see `data-autofocus`.
    expect(body, WHY_TILE).toContain('setLastOpenedIndex(index)');
    expect(body, WHY_TILE).toContain('autoFocus={lastOpenedIndex === index}');
  });

  const WHY_BUTTON =
    'The screenshot tile is no longer a real <button>. An <img onClick> is not ' +
    'tab-reachable, is not Enter/Space-activatable and exposes no accessible name, ' +
    'so the whole gallery becomes mouse-only. Use UnstyledButton (see ScreenshotTile).';

  it('🔴 the tile is a real button, and the image is not the click target', () => {
    const tile = norm(fnBody(bodySrc(), 'ScreenshotTile'));
    expect(tile, WHY_BUTTON).not.toBe('');
    expect(tile, WHY_BUTTON).toContain('<UnstyledButton');
    expect(tile, WHY_BUTTON).toContain('onClick={onOpen}');
    // The handler belongs to the button, not to the image — a click handler on the
    // `<img>` would render as a mouse-only affordance that LOOKS wired up.
    expect(tile.split('<img')[1] ?? '', WHY_BUTTON).not.toContain('onClick');
    // Positive control for that slice: the part BEFORE the `<img>` really does
    // contain the handler, so `not.toContain` above is about the split and not about
    // a needle that appears nowhere in the function.
    expect(tile.split('<img')[0]).toContain('onClick={onOpen}');
  });

  /**
   * 🔴 THE MODAL'S A11Y CONTRACT IS A SET OF MANTINE DEFAULTS, AND DEFAULTS ARE EXACTLY
   * WHAT GETS SWITCHED OFF IN PASSING. `trapFocus`, `returnFocus` and `closeOnEscape`
   * all default to `true` (`@mantine/core` `Modal.mjs`), which is why the viewer sets
   * none of them — and why nothing in a diff would draw attention to a `={false}`
   * appearing.
   *
   * 🔴 READ THE `closeOnEscape` LINE FOR EXACTLY WHAT IT SAYS, WHICH IS LESS THAN IT
   * LOOKS. It pins that Escape is not switched OFF. That is the MIRROR IMAGE of the
   * defect this feature actually had — one Escape closing the viewer AND the moderator
   * review modal it is nested in — and while this assertion was the only thing here
   * mentioning Escape, the area READ as covered while the real hazard was untested. A
   * guard that certifies the opposite half of a hazard is worse than no guard, because
   * it answers the question nobody needed answered. The nesting behaviour is a
   * RELATIONSHIP between two dialogs, so it is asserted as one, in
   * `AppListingDetailBody.viewer.browser.test.tsx` ("nested inside the moderator review
   * modal"), and its structural half is the `Modal.Stack` seam in the test below.
   */
  it('🔴 the viewer does not switch OFF focus trap or Esc', () => {
    const src = norm(viewerSrc());
    for (const prop of ['trapFocus', 'closeOnEscape', 'withCloseButton']) {
      // Positive control first: the matcher can see such a thing at all.
      expect(norm(`<Modal ${prop}={false} />`)).toContain(`${prop}={false}`);
      expect(
        src,
        `AppListingScreenshotViewer sets ${prop}={false}. That is the modal's a11y ` +
          `contract — focus moves into the dialog and Escape closes it. Both are ` +
          `Mantine defaults, so turning one off is a one-word edit no reviewer would flag.`
      ).not.toContain(`${prop}={false}`);
    }
    // …and the dialog really is labelled, which is what `aria-labelledby` resolves to.
    expect(src).toContain('title={`${name} screenshots`}');
  });

  /**
   * 🔴 `returnFocus={false}` IS REQUIRED HERE, NOT FORBIDDEN — and an earlier version
   * of this gate had it exactly backwards, which would have blocked its own fix.
   *
   * Inside a `Modal.Stack` Mantine's focus return is BROKEN for every member: the stack
   * gates `trapFocus` on `ctx.currentId === stackId`, that value flips while the modal
   * is open, and `useFocusReturn`'s deps `[opened, shouldReturnFocus]` make each flip
   * re-capture `document.activeElement` — by then something inside the dialog.
   * Measured: focus lands on `<body>`. So each stacked modal turns Mantine's version
   * OFF and uses `useOpenerFocusReturn`, which captures the opener during RENDER,
   * before the trap can move focus.
   *
   * 🔴 THE TWO HALVES ARE NOT EQUALLY LOAD-BEARING, AND THIS GATE USED TO SAY THEY
   * WERE. `returnFocus={false}` without the hook is a real regression — no focus
   * return at all, measured. The reverse is NOT: an independent sweep deleted
   * `returnFocus={false}` while keeping the hook and every focus test stayed GREEN;
   * only this gate noticed. The earlier claim that Mantine's 10ms post-close timeout
   * would clobber the correct restore was reasoning, and it was wrong.
   *
   * The gate still requires both, as a SINGLE-OWNER convention: one mechanism owns
   * focus return, and Mantine's corrupted capture is left inert rather than racing us
   * in some flow nobody has measured. That is a convention worth pinning; it is not
   * evidence of a behavioural pair, and this comment must not be read as claiming so.
   */
  it('🔴 every stacked modal pairs returnFocus={false} with useOpenerFocusReturn', () => {
    const REVIEW = path.resolve(__dirname, '../OffsiteReviewQueue.tsx');
    const COMBINED = path.resolve(__dirname, '../CombinedReviewModal.tsx');
    const VIEWER_PATH = path.resolve(__dirname, '../AppListingScreenshotViewer.tsx');

    // Positive controls — each matcher can see its target, and the comment stripper
    // stops the prose in these files (which names both halves) from satisfying it.
    expect(norm('<Modal returnFocus={false} />')).toContain('returnFocus={false}');
    expect(norm('useOpenerFocusReturn(opened);')).toContain('useOpenerFocusReturn(');
    expect(norm(stripComments('/* returnFocus={false} useOpenerFocusReturn( */'))).not.toContain(
      'returnFocus={false}'
    );

    for (const file of [VIEWER_PATH, REVIEW, COMBINED]) {
      const name = path.basename(file);
      const src = norm(stripComments(fs.readFileSync(file, 'utf8')));
      const why =
        `${name} joins a Modal.Stack, where Mantine's own returnFocus captures the ` +
        `wrong element and drops the user on <body>. It must set returnFocus={false} ` +
        `AND call useOpenerFocusReturn(...). Dropping the HOOK is a measured ` +
        `regression (no focus return at all). Dropping the PROP is a convention ` +
        `violation rather than a measured break — it left the focus tests green — ` +
        `but it leaves two mechanisms owning focus return, one of them corrupted.`;
      expect(src, why).toContain('returnFocus={false}');
      expect(src, why).toContain('useOpenerFocusReturn(');
    }
  });

  /**
   * 🔴 THE SECOND SEAM: `Modal.Stack` IS TWO HALVES IN TWO FILES, AND NEITHER ERRORS
   * ALONE.
   *
   * In the `preview` posture the listing body renders inside `OffsiteReviewQueue`'s
   * review `<Modal>`, so the screenshot viewer is a Modal nested in a Modal. Mantine's
   * Esc handling is a per-Modal `window` keydown listener in CAPTURE phase, so without
   * coordination one key closes BOTH — taking the moderator's in-progress rejection
   * reason and their place in the queue with it.
   *
   * The fix pairs a `stackId` on the viewer with a `Modal.Stack` wrapper on the review
   * modal, and the failure mode of losing either half is SILENCE: `stackId` with no
   * `Modal.Stack` ancestor is inert (`stackProps` is applied only `if (ctx && stackId)`),
   * and a `Modal.Stack` around a single modal changes nothing. Nothing throws, nothing
   * warns, and the regression is only visible by opening a screenshot from the review
   * queue and pressing one key. That is what makes it a seam rather than two settings.
   */
  it('🔴 the viewer joins a Modal.Stack that BOTH of its hosts actually provide', () => {
    const viewer = norm(viewerSrc());

    // Positive controls: the matchers can see their target, and the comment stripper
    // is what stops each file's own PROSE (which names both halves verbatim) from
    // satisfying the gate.
    const stacked = (id: string) =>
      new RegExp(`<Modal\\.Stack>\\s*<Modal\\b[\\s\\S]{0,200}?stackId="${id}"`);
    expect(norm('<Modal.Stack> <Modal returnFocus={false} stackId="x"')).toMatch(stacked('x'));
    // …and it is a PROXIMITY check, not a pair of independent substrings: a stackId
    // that belongs to some other modal far away in the file does not satisfy it.
    expect(norm(`<Modal.Stack><Modal/></Modal.Stack> ${'z'.repeat(400)} stackId="x"`)).not.toMatch(
      stacked('x')
    );
    expect(norm(stripComments('/* <Modal.Stack> <Modal stackId="offsite-review" */'))).not.toMatch(
      /<Modal\.Stack>/
    );

    expect(
      viewer,
      'AppListingScreenshotViewer no longer joins a modal stack. Nested inside a ' +
        'moderator review modal, one Escape will now close BOTH dialogs and discard ' +
        'whatever the moderator had typed. See the header on its `stackId` prop.'
    ).toContain('stackId="app-listing-screenshot-viewer"');

    /**
     * 🔴 BOTH HOSTS, because there are two and only one of them was obvious. The
     * listing preview — and therefore this viewer — is rendered by
     * `OffsiteReviewModalBody`, which BOTH `OffsiteReviewModal` and
     * `CombinedReviewModal` mount inside their own `<Modal>`. Fixing only the first
     * leaves the identical Escape defect live on the combined code+media review.
     *
     * 🔴 ASSERTED AS PROXIMITY, not as two independent substrings. A file can contain
     * `<Modal.Stack>` and a `stackId` while the wrapper sits around a DIFFERENT modal —
     * which the substring form would happily pass. The regex pins that the id belongs
     * to the modal directly inside the wrapper, with a 200-char window so a legitimate
     * prop reorder does not break the gate. Residual gap, stated rather than implied: a
     * second `<Modal>` inserted between the wrapper and this one, within that window,
     * would still satisfy it. Closing that needs a real JSX parse, which is more
     * machinery than this class of regression warrants.
     */
    for (const [file, stackId] of [
      ['../OffsiteReviewQueue.tsx', 'offsite-review'],
      ['../CombinedReviewModal.tsx', 'combined-review'],
    ] as const) {
      const src = norm(stripComments(fs.readFileSync(path.resolve(__dirname, file), 'utf8')));
      expect(
        src,
        `${path.basename(file)} no longer wraps its review Modal in a <Modal.Stack> ` +
          `carrying stackId="${stackId}". The screenshot viewer's own stackId is INERT ` +
          `without it (Modal.mjs applies stack props only \`if (ctx && stackId)\`), so ` +
          `Escape silently goes back to closing both dialogs at once — losing the ` +
          `moderator's in-progress review notes. Both halves are required; neither ` +
          `errors alone.`
      ).toMatch(stacked(stackId));
    }
  });
});
