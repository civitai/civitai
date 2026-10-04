import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { FileDiffEntry, SKIP_LABEL, type FileLineDiff } from '~/components/Apps/reviewDiffPanels';

/**
 * The GITHUB-SHAPED per-file diff viewer.
 *
 * The panel used to be a collapsible `<Code>` block: one `Text` per line, sigil-coloured,
 * with NO line numbers at all. A moderator reading a finding that cites `src/run.ts:88`
 * had nothing on screen to find line 88 with.
 *
 * 🔴 ONE RENDERER, BOTH SURFACES. This component renders in the queue MODAL (via the shared
 * body's code-diff panel, and again inside `CombinedReviewModal`) and in the review PAGE's
 * Code tab. The page redesign rearranges which panels go where; it deliberately does not
 * fork the panel.
 *
 * 🔴 NO NEW RUNTIME DEPENDENCY. `react-diff-view` would need these hunks re-serialised to
 * unified text and re-parsed to recover the structure the server already sends, in a PUBLIC
 * repo where a runtime dep carries bundle weight plus maintenance. The line-number WALK —
 * the part that can be silently wrong — is pure and lives in `reviewDiffRows.ts`, pinned in
 * the node-env `unit` project. What only a render can show is below.
 */

/** A changed file with a mid-file hunk, so a wrong start offset cannot hide at line 1. */
const CHANGED: FileLineDiff = {
  path: 'src/App.tsx',
  changeKind: 'changed',
  skipReason: null,
  added: 12,
  removed: 3,
  hunks: [
    {
      oldStart: 41,
      oldLines: 3,
      newStart: 41,
      newLines: 4,
      lines: [
        ' const x = useState()',
        '+const y = useMemo(() => 1, [])',
        '-const y = compute()',
        ' return <div/>',
      ],
    },
  ],
};

/**
 * A file whose edit CANNOT pair evenly: one line replaced by two.
 *
 * 🔴 THE UNEVEN RUN IS THE POINT. `splitDiffRows` pairs each contiguous `-` run against the
 * `+` run that follows it, so a 1-del/1-add edit pairs exactly and produces NO filler cell —
 * which is how the split colour sweep came to run over a surface that was not on screen.
 */
const UNEVEN: FileLineDiff = {
  ...CHANGED,
  hunks: [
    {
      oldStart: 41,
      oldLines: 2,
      newStart: 41,
      newLines: 4,
      lines: [
        ' const x = useState()',
        '-const y = compute()',
        '+const y = useMemo(() => 1, [])',
        '+const z = useMemo(() => 2, [])',
        ' return <div/>',
      ],
    },
  ],
};

const expand = async () => {
  await page.getByText('src/App.tsx').click();
};

/** Every rendered row's `[oldNo, newNo, kind]`, read off the table. */
const rows = () =>
  Array.from(
    document.querySelectorAll<HTMLTableRowElement>(
      '[data-testid="apps-review-diff-unified"] tr[data-line-kind]'
    )
  ).map((tr) => {
    const cells = Array.from(tr.querySelectorAll('td'));
    return [
      cells[0]?.textContent?.trim() ?? '',
      cells[1]?.textContent?.trim() ?? '',
      tr.getAttribute('data-line-kind'),
    ];
  });

describe('the per-file header', () => {
  test('🔴 carries the path and the `+N −M` counts, and STICKS', async () => {
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expect.element(page.getByText('src/App.tsx')).toBeInTheDocument();
    await expect.element(page.getByText('+12')).toBeInTheDocument();
    await expect.element(page.getByText('−3')).toBeInTheDocument();
    // The header must be `position: sticky` — a long file whose header scrolls away leaves
    // the mod reading numbers with no idea which file they belong to.
    //
    // 🔴 ON THE HEADER ELEMENT ITSELF, NOT "SOME STICKY ANCESTOR". The looser form accepted
    // `el === header` as well as any wrapper, so moving the declaration up to the `Card` —
    // which breaks the float-over-code behaviour entirely, since the card is not inside the
    // scroller — still passed.
    // 🔴 THE HEADER BY TESTID, NOT `closest('div')` FROM THE PATH TEXT. The path sits inside
    // an inner `Group`, so `closest` returned THAT — and the first version of this assertion
    // read `static` off it and would have been "fixed" by loosening back to "some sticky
    // ancestor", which is the check that could not see the regression it exists for.
    const header = page.getByTestId('apps-review-diff-file-header').element() as HTMLElement;
    const style = getComputedStyle(header);
    expect(style.position, 'the file header is position: sticky').toBe('sticky');
    expect(style.top, 'the file header sticks to the top of its scroller').toBe('0px');
  });

  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — its own title says "unchanged", so label it
   * rather than let the count read as redesign coverage. `origin/main`'s `FileDiffEntry` was
   * already `useState(false)` (the brief's "don't regress the laziness"); this pins that the
   * rewrite kept it.
   *
   * ⚠️ NOT REPORTABLE AT THE BASE, and the reason is NOT the one an earlier draft gave. That
   * draft said `FileDiffEntry` "does not exist" on `origin/main` — it does, at
   * `reviewDiffPanels.tsx:86`, with `DiffHunkView` as its CHILD. What actually stops this
   * file loading there is that `SKIP_LABEL` is a module-private `const` on main while this
   * file imports it at module scope. And had it loaded, THIS case would have passed
   * VACUOUSLY: the testid it asserts zero of does not exist on main at all, so "green at the
   * base" would have been the wrong grade even where it was reachable. See the two blocks
   * below, which carry the same correction.
   */
  test('INVARIANT GUARD: collapsed by default — the laziness is unchanged', async () => {
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expect.element(page.getByText('src/App.tsx')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="apps-review-diff-unified"]')).toHaveLength(0);
  });
});

describe('unified layout (the default)', () => {
  test('🔴 OLD AND NEW LINE-NUMBER GUTTERS, mapped correctly', async () => {
    // The whole reason the viewer was rebuilt. A renderer that paints the right colours
    // against the wrong numbers looks completely fine.
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expand();
    await expect.element(page.getByTestId('apps-review-diff-unified')).toBeInTheDocument();
    expect(rows()).toEqual([
      ['41', '41', 'context'],
      // an ADD has no old-side number…
      ['', '42', 'add'],
      // …and a DELETE has no new-side number.
      ['42', '', 'del'],
      ['43', '43', 'context'],
    ]);
  });

  test('the `@@` hunk range is rendered as a separator', async () => {
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expand();
    await expect.element(page.getByText('@@ -41,3 +41,4 @@')).toBeInTheDocument();
  });

  test('the code keeps its +/- sigil — the one signal that survives a screenshot', async () => {
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expand();
    await expect.element(page.getByText('+const y = useMemo(() => 1, [])')).toBeInTheDocument();
    await expect.element(page.getByText('-const y = compute()')).toBeInTheDocument();
  });

  test('🔴 the code area scrolls HORIZONTALLY — the page body never does', async () => {
    // A long line must overflow its own box, not the document. `white-space: pre` is the
    // other half: wrapping would re-flow the code against its own line numbers.
    const long: FileLineDiff = {
      ...CHANGED,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [`+const veryLong = '${'x'.repeat(600)}'`],
        },
      ],
    };
    renderWithProviders(<FileDiffEntry file={long} />);
    await expand();
    const table = page.getByTestId('apps-review-diff-unified').element();
    const scroller = table.parentElement!;
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    // The row is wider than its scroller, i.e. the overflow is real rather than asserted.
    expect(table.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    // …and the DOCUMENT is not wider than the viewport because of it.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth + 1
    );
    // The code cell does not wrap.
    const codeCell = table.querySelector('tr[data-line-kind] td:nth-child(3)')!;
    expect(getComputedStyle(codeCell).whiteSpace).toBe('pre');
  });

  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — and not by the "green at `origin/main`"
   * method, which cannot apply here. `origin/main`'s `reviewDiffPanels.tsx` already painted
   * every surface through `light-dark(...)` (5 occurrences, and a header note saying why), so
   * this pins a rule the rewrite had to CARRY OVER rather than a defect anyone watched. The
   * rewrite introduced new painted surfaces — the sticky file header, the split filler cell —
   * which is the reason to re-pin it at all. Do not count it toward "the redesign is tested".
   *
   * ⚠️ WHY IT CANNOT BE RUN AT THE BASE, corrected: not because `FileDiffEntry` is absent —
   * it is present on main at `reviewDiffPanels.tsx:86` — but because this file imports the
   * module-private `SKIP_LABEL` at module scope, so the whole file fails to load there.
   */
  test('🔴 EVERY painted background is `light-dark(...)` — the "white diff box in dark mode" bug', async () => {
    // This module was corrected for that defect once; a fixed light-only shade here is the
    // regression. Asserted on the AUTHORED inline style string, which the browser preserves
    // verbatim, so it is colour-scheme independent.
    //
    // 🔴 THE TEST IS "IS THIS TOKEN FIXED IN BOTH SCHEMES", NOT "DOES IT END IN A DIGIT".
    //
    // The first version of this sweep skipped anything without a trailing `-<digit>`, which
    // skips `--mantine-color-white` — the exact spelling its own comment named as walkable.
    // Measured: `PANEL_BG = 'var(--mantine-color-white)'` paints a literally white slab in
    // dark mode, and that sweep printed nothing and passed.
    //
    // ⚠️ THE OBVIOUS REPAIR — invert it and allowlist the semantic names — OVERSHOOTS, and
    // this is the measurement that says so rather than an opinion: it immediately red-flagged
    // `--mantine-color-yellow-light`, which Mantine's own `Badge` writes into `--badge-bg` and
    // which Mantine REDEFINES under `[data-mantine-color-scheme="dark"]`. The `*-light*`,
    // `*-filled*` and `*-outline*` families are all scheme-computed, as are the semantic
    // tokens — and none of them are ours to police anyway.
    //
    // What is genuinely fixed in both schemes is the NUMBERED SHADES plus `white` and `black`.
    // That is the set, and it is derived from the hazard rather than from today's spellings.
    const isFixedInBothSchemes = (token: string) =>
      /^[a-z]+-[0-9]$/.test(token) || token === 'white' || token === 'black';

    const sweep = (label: string) => {
      const styles = Array.from(document.querySelectorAll<HTMLElement>('[style]')).map(
        (el) => el.getAttribute('style') ?? ''
      );
      let checked = 0;
      for (const style of styles) {
        // 🔴 STRIP THE `light-dark(...)` SPANS, THEN LOOK AT WHAT IS LEFT — and two earlier
        // forms of this sweep were walkable because they asked a containment question
        // instead. v1 asserted on the whole ELEMENT's style: a fixed shade passed as long as
        // ANY declaration on it was scheme-aware. v2 narrowed the subject to the DECLARATION
        // and kept `toContain('light-dark(')` — still containment, so ONE declaration holding
        // both survives. Measured, with the edit that produces it:
        // `background: linear-gradient(${GUTTER_BG}, var(--mantine-color-white))` paints a
        // literal white stop in dark mode and printed `16 passed`.
        //
        // Removing the spans asks the question directly: once every `light-dark(…)` is gone,
        // no fixed-in-both-schemes token may remain. It also retires the `;` split, which was
        // its own hazard — a `;` inside a quoted value (a `font-family`) would orphan a
        // fragment and fail healthy code.
        for (const [, token] of style.matchAll(/--mantine-color-([a-z0-9-]+)/g)) {
          if (isFixedInBothSchemes(token)) checked += 1;
        }
        // ⚠️ ONE LEVEL OF NESTING. `light-dark(linear-gradient(var(--a), white), …)` — two
        // levels — is not matched, so the span is not stripped and healthy code would RED.
        // That is the false-POSITIVE direction, i.e. loud and safe, and nothing in this file
        // needs two levels today; widen it when something does rather than in advance.
        const outside = style.replace(/light-dark\((?:[^()]|\([^()]*\))*\)/g, '');
        const stray = Array.from(outside.matchAll(/--mantine-color-([a-z0-9-]+)/g))
          .map(([, t]) => t)
          .filter(isFixedInBothSchemes);
        expect(stray, `${label}: painted OUTSIDE light-dark() in \`${style.trim()}\``).toEqual([]);
      }
      // 🔴 POSITIVE CONTROL PER PASS. A sweep that matched no tokens at all would be a
      // reassuring zero, indistinguishable from a clean one.
      expect(checked, `${label}: the sweep examined no colour tokens`).toBeGreaterThan(0);
      return styles;
    };

    renderWithProviders(<FileDiffEntry file={UNEVEN} />);
    await page.getByText('src/App.tsx').click();
    await expect.element(page.getByTestId('apps-review-diff-unified')).toBeInTheDocument();
    const unifiedStyles = sweep('unified');
    expect(unifiedStyles.some((s) => s.includes('light-dark(') && s.includes('green-9'))).toBe(
      true
    );
    expect(unifiedStyles.some((s) => s.includes('light-dark(') && s.includes('red-9'))).toBe(true);

    // …and again in SPLIT, where the `empty` FILLER cell is the only painted surface the
    // unified pass cannot reach.
    await page.getByRole('radio', { name: 'Split' }).click();
    await expect.element(page.getByTestId('apps-review-diff-split')).toBeInTheDocument();
    // 🔴 STRUCTURAL CONTROL: the fixture must actually PRODUCE a filler. `UNEVEN` replaces one
    // line with two, so the del/add runs cannot pair evenly — the earlier fixture (1 del, 1
    // add) paired exactly and produced ZERO fillers, so that pass swept a surface that was not
    // on screen. The cell is identified by its empty text in a split row, not by a colour
    // string (its value is byte-identical to the gutter's).
    const splitRows = Array.from(
      document.querySelectorAll('[data-testid="apps-review-diff-split"] tr')
    );
    const fillerCells = splitRows.flatMap((tr) =>
      Array.from(tr.querySelectorAll('td')).filter(
        (td) => td.getAttribute('style')?.includes('light-dark(') && td.textContent === ''
      )
    );
    expect(fillerCells.length, 'the split fixture produced an empty filler cell').toBeGreaterThan(
      0
    );
    sweep('split');
  });
});

describe('split layout (opt-in, per file)', () => {
  test('🔴 the toggle switches to a FOUR-column table, and back', async () => {
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expand();
    await expect.element(page.getByTestId('apps-review-diff-layout')).toBeInTheDocument();
    await page.getByRole('radio', { name: 'Split' }).click();
    await expect.element(page.getByTestId('apps-review-diff-split')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-testid="apps-review-diff-unified"]')).toHaveLength(0);
    const first = document.querySelector('[data-testid="apps-review-diff-split"] tr:nth-child(2)');
    expect(first?.querySelectorAll('td')).toHaveLength(4);

    await page.getByRole('radio', { name: 'Unified' }).click();
    await expect.element(page.getByTestId('apps-review-diff-unified')).toBeInTheDocument();
  });

  test('🔴 switching layout does NOT collapse the file you were reading', async () => {
    // The whole header toggles the file open, so without `stopPropagation` around the
    // control, changing layout also closes the diff.
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expand();
    await page.getByRole('radio', { name: 'Split' }).click();
    await expect.element(page.getByTestId('apps-review-diff-split')).toBeInTheDocument();
  });

  test('the layout control only exists once a file is OPEN', async () => {
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expect.element(page.getByText('src/App.tsx')).toBeInTheDocument();
    expect(page.getByTestId('apps-review-diff-layout').elements()).toHaveLength(0);
  });
});

describe('elided files keep their labels, and NO link out (#3498)', () => {
  const elided = (skipReason: NonNullable<FileLineDiff['skipReason']>): FileLineDiff => ({
    path: 'assets/logo.png',
    changeKind: 'changed',
    skipReason,
    added: 0,
    removed: 0,
    hunks: [],
  });

  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — but NOT by the usual method, and the
   * difference matters because the usual claim would be FALSE here.
   *
   * Every other invariant-guard label in this change says "run against `origin/main` and
   * PASSED there". That is impossible for this block — but ⚠️ NOT for the reason an earlier
   * draft gave. It said `FileDiffEntry` "does not exist" on `origin/main` and "replaces
   * `DiffHunkView`". Both are false: `FileDiffEntry` is exported on main at
   * `reviewDiffPanels.tsx:86`, and `DiffHunkView` is its CHILD there, called from its body.
   * The rewrite replaced `FileDiffEntry`'s INNARDS and deleted the child.
   *
   * What really stops the run is narrower and checkable: `SKIP_LABEL` is a module-private
   * `const` on main (`reviewDiffPanels.tsx:79`) and this file imports it at module scope, so
   * the whole file fails to load — and separately none of the testids, the `SegmentedControl`
   * or the sticky header exist there to assert against. A test that cannot be RUN at the base
   * cannot be reported red or green at it.
   *
   * What makes it an invariant guard anyway is the requirement, not the test: `origin/main`
   * already rendered `SKIP_LABEL[file.skipReason]` verbatim and already carried no anchor
   * (#3498 removed the deep-link). So this pins a rule the redesign had to CARRY OVER through
   * a rewrite of the component's body — the thing a rewrite loses silently — and it never
   * watched a defect. Do not count it toward "the redesign is tested".
   */
  test.each(Object.entries(SKIP_LABEL) as Array<[NonNullable<FileLineDiff['skipReason']>, string]>)(
    '🔴 skipReason "%s" states the reason VERBATIM and offers no anchor',
    async (skipReason, label) => {
      // The labels are asserted against `SKIP_LABEL` itself rather than against re-typed
      // strings, so a reword cannot silently diverge from what the module exports. The
      // "— view in Forgejo" deep-links were retired because in-review snapshots are private
      // and an anonymous click 404s: a dead link is worse than none.
      const { container } = await renderWithProviders(<FileDiffEntry file={elided(skipReason)} />);
      await expect.element(page.getByText(label)).toBeInTheDocument();
      expect(container.querySelectorAll('a')).toHaveLength(0);
      expect(document.querySelectorAll('a[href]')).toHaveLength(0);
      // Clicking an elided row must not expand anything into existence either.
      await page.getByText('assets/logo.png').click();
      expect(document.querySelectorAll('a[href]')).toHaveLength(0);
      expect(page.getByTestId('apps-review-diff-layout').elements()).toHaveLength(0);
      expect(page.getByTestId('apps-review-diff-unified').elements()).toHaveLength(0);
    }
  );

  test('🔴 POSITIVE CONTROL: the label set is the full one, not an accidentally-empty map', async () => {
    // `test.each` over an empty object runs zero cases and reports green.
    expect(Object.keys(SKIP_LABEL)).toEqual(['binary', 'too-large', 'diff-too-large', 'file-cap']);
  });
});

describe('a file with no textual change', () => {
  /**
   * 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE. `origin/main` already printed this exact
   * sentence for a file whose hunks are empty; the rewrite had to carry it over, and a table
   * renderer that produced an empty `<table>` instead would look like a bug in the data.
   * Not reportable at the base for the same reason as the blocks above — the module-scope
   * `SKIP_LABEL` import, not an absent component.
   */
  test('INVARIANT GUARD: says so rather than rendering an empty table', async () => {
    renderWithProviders(<FileDiffEntry file={{ ...CHANGED, hunks: [], added: 0, removed: 0 }} />);
    await expand();
    await expect
      .element(page.getByText('No textual change (whitespace/metadata only).'))
      .toBeInTheDocument();
  });
});
