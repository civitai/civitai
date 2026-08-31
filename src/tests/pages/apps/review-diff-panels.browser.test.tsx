import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so reach it relatively (apps → pages → tests → src → root).
import { renderWithProviders } from '../../../../test/component-setup';
import {
  DiffHunkView,
  FileDiffEntry,
  FileListPreview,
  ManifestDiffPreview,
  type FileLineDiff,
} from '~/components/Apps/reviewDiffPanels';

/**
 * Bug 2 regression — the on-site /apps/review diff panels rendered a fixed light
 * `gray-0` (and `green-0`/`red-0` line highlights), so in the dark color scheme
 * the "changed"/diff boxes rendered as white slabs. The fix uses the codebase's
 * theme-aware `light-dark(...)` convention so the panels remap for dark mode.
 *
 * These assertions are color-scheme-independent: they check the AUTHORED inline
 * style string (which the browser preserves verbatim on the `style` attribute)
 * contains a `light-dark(...)` value with a dark-scheme fallback — i.e. the
 * background is NOT hardcoded light-only. That catches a regression to a bare
 * `var(--mantine-color-gray-0)` without depending on computed-style resolution.
 */

const inlineStyles = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[style]')).map(
    (el) => el.getAttribute('style') ?? ''
  );

// Every element that paints a `gray-0`/`green-0`/`red-0` diff surface must wrap
// it in `light-dark(...)` — a bare light-only token is the bug.
const assertNoLightOnlyDiffBg = () => {
  for (const s of inlineStyles()) {
    for (const token of ['gray-0', 'green-0', 'red-0']) {
      if (s.includes(`var(--mantine-color-${token})`)) {
        expect(s, `light-only ${token} background must be wrapped in light-dark()`).toContain(
          'light-dark('
        );
      }
    }
  }
};

describe('reviewDiffPanels — dark-theme-aware backgrounds (Bug 2)', () => {
  test('FileListPreview panel uses a light-dark background, not a fixed light gray', async () => {
    renderWithProviders(
      <FileListPreview added={['a.ts']} removed={['b.ts']} changed={['c.ts']} />
    );
    await expect.element(page.getByText('a.ts')).toBeInTheDocument();
    const panel = inlineStyles().find(
      (s) => s.includes('light-dark(') && s.includes('gray-0') && s.includes('dark-6')
    );
    expect(panel, 'FileListPreview scroll panel background').toBeTruthy();
    assertNoLightOnlyDiffBg();
  });

  test('ManifestDiffPreview panel uses a light-dark background', async () => {
    renderWithProviders(
      <ManifestDiffPreview diff={{ added: ['scopes'], removed: [], changed: [] }} />
    );
    await expect.element(page.getByText('scopes')).toBeInTheDocument();
    const panel = inlineStyles().find(
      (s) => s.includes('light-dark(') && s.includes('gray-0') && s.includes('dark-6')
    );
    expect(panel, 'ManifestDiffPreview scroll panel background').toBeTruthy();
    assertNoLightOnlyDiffBg();
  });

  test('DiffHunkView +/- line highlights are dark-aware (green-9/red-9 fallbacks)', async () => {
    renderWithProviders(
      <DiffHunkView
        hunk={{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          lines: ['+added line', '-removed line', ' context line'],
        }}
      />
    );
    await expect.element(page.getByText('+added line')).toBeInTheDocument();
    const styles = inlineStyles();
    const added = styles.find((s) => s.includes('light-dark(') && s.includes('green-9'));
    const removed = styles.find((s) => s.includes('light-dark(') && s.includes('red-9'));
    expect(added, 'added-line highlight uses light-dark green').toBeTruthy();
    expect(removed, 'removed-line highlight uses light-dark red').toBeTruthy();
    assertNoLightOnlyDiffBg();
  });

  test('FileDiffEntry code panel (once expanded) uses a light-dark background', async () => {
    const file: FileLineDiff = {
      path: 'src/changed-file.ts',
      changeKind: 'changed',
      skipReason: null,
      added: 1,
      removed: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['+new', '-old'],
        },
      ],
    };
    renderWithProviders(<FileDiffEntry file={file} />);

    // Collapsed by default → no diff panel painted yet.
    expect(
      inlineStyles().some((s) => s.includes('light-dark(') && s.includes('dark-6'))
    ).toBe(false);

    // Expand the entry (its header toggles the code panel).
    await page.getByText('src/changed-file.ts').click();

    const panel = inlineStyles().find(
      (s) => s.includes('light-dark(') && s.includes('gray-0') && s.includes('dark-6')
    );
    expect(panel, 'FileDiffEntry expanded code panel background').toBeTruthy();
    assertNoLightOnlyDiffBg();
  });
});

/**
 * #3498 regression guard for the ELIDED-file row.
 *
 * A file that cannot be diffed inline (binary, too large, over the diff/file
 * cap) used to render a per-file button linking straight out to the raw
 * in-review snapshot, and its label ended in "— view in Forgejo". That
 * affordance was removed; the row now just states the reason.
 *
 * This is the only place that guard can be asserted for real: an elided row only
 * exists when `FileDiffEntry` is mounted with a non-null `skipReason`, so a
 * "no external link" assertion made anywhere the component isn't mounted (e.g.
 * against the review modal, whose code-diff panel is collapsed by default) is
 * vacuous — it passes on the unfixed code too.
 */
const ELIDED_LABELS: Array<[NonNullable<FileLineDiff['skipReason']>, string]> = [
  ['binary', 'Binary file — no inline diff'],
  ['too-large', 'File too large to diff'],
  ['diff-too-large', 'Diff too large to display'],
  ['file-cap', 'Too many changed files — this one not diffed'],
];

const elidedFile = (skipReason: NonNullable<FileLineDiff['skipReason']>): FileLineDiff => ({
  path: 'assets/logo.png',
  changeKind: 'changed',
  skipReason,
  added: 0,
  removed: 0,
  hunks: [],
});

describe('reviewDiffPanels — an elided file offers no external link (#3498)', () => {
  for (const [skipReason, label] of ELIDED_LABELS) {
    test(`skipReason "${skipReason}" states the reason and renders no link out`, async () => {
      const { container } = await renderWithProviders(
        <FileDiffEntry file={elidedFile(skipReason)} />
      );

      // The row is mounted and the reason is what the mod is shown instead.
      await expect.element(page.getByText(label)).toBeInTheDocument();
      await expect.element(page.getByText('assets/logo.png')).toBeInTheDocument();

      // 🔴 THE GUARD: no anchor at all — not the old button, not any other
      // deep-link out of the in-app diff.
      expect(container.querySelectorAll('a').length, 'anchors inside the file row').toBe(0);
      expect(document.querySelectorAll('a[href]').length, 'anchors on the page').toBe(0);
      expect(page.getByText('View in Forgejo').elements()).toHaveLength(0);

      // Clicking an elided row must not expand a link into existence either —
      // an elided entry has nothing to expand.
      await page.getByText('assets/logo.png').click();
      expect(document.querySelectorAll('a[href]').length, 'anchors after click').toBe(0);
      expect(page.getByText('View in Forgejo').elements()).toHaveLength(0);
    });
  }
});
