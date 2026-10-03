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
    // the mod reading numbers with no idea which file they belong to. Asserted on the
    // RESOLVED style, so a refactor that moved the declaration still counts.
    const header = page.getByText('src/App.tsx').element().closest('div');
    const sticky = Array.from(document.querySelectorAll<HTMLElement>('div')).find(
      (el) => getComputedStyle(el).position === 'sticky' && el.contains(header!)
    );
    expect(sticky, 'a sticky ancestor around the file header').toBeTruthy();
  });

  test('collapsed by default — the laziness is unchanged', async () => {
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

  test('🔴 EVERY painted background is `light-dark(...)` — the "white diff box in dark mode" bug', async () => {
    // This module was corrected for that defect once; a fixed `green-0`/`red-0`/`gray-0`
    // here is the regression. Asserted on the AUTHORED inline style string, which the
    // browser preserves verbatim, so it is colour-scheme independent.
    renderWithProviders(<FileDiffEntry file={CHANGED} />);
    await expand();
    const styles = Array.from(document.querySelectorAll<HTMLElement>('[style]')).map(
      (el) => el.getAttribute('style') ?? ''
    );
    for (const s of styles) {
      for (const token of ['gray-0', 'gray-1', 'green-0', 'red-0']) {
        if (s.includes(`var(--mantine-color-${token})`)) {
          expect(s, `light-only ${token} must be wrapped in light-dark()`).toContain('light-dark(');
        }
      }
    }
    // POSITIVE CONTROL: the add/delete highlights really are painted (an empty sweep above
    // would pass vacuously).
    expect(styles.some((s) => s.includes('light-dark(') && s.includes('green-9'))).toBe(true);
    expect(styles.some((s) => s.includes('light-dark(') && s.includes('red-9'))).toBe(true);
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
  test('says so rather than rendering an empty table', async () => {
    renderWithProviders(<FileDiffEntry file={{ ...CHANGED, hunks: [], added: 0, removed: 0 }} />);
    await expand();
    await expect
      .element(page.getByText('No textual change (whitespace/metadata only).'))
      .toBeInTheDocument();
  });
});
