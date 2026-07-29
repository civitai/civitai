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
    renderWithProviders(<FileDiffEntry file={file} forgejoUrl="https://forge.example/x" />);

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
