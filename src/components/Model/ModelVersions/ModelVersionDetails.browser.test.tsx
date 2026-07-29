import { describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import classes from './ModelVersionDetails.module.scss';

// =============================================================================
// ModelVersionDetails — "Details" metadata table static-CSS conversion.
//
// This PR replaces the ~10 per-render Mantine style-props rows in the Details
// accordion (`<Group justify="space-between" px="md" py={10} style={{border…}}>`
// + `<Text size="sm" c="dimmed">` labels + `<Box p="sm" style={{border…}}>` file
// rows) with static CSS-module classes (`.detailRow` / `.detailRowTop` /
// `.detailRowPlain` / `.fileRow` / `.detailLabel` / `.detailsPanel`). The visual
// output must be pixel-identical; the only dynamic input — the colorScheme
// border/background ternary — is handled by `light-dark()` in the module, which
// postcss-preset-mantine compiles to an unscoped (light) rule + a
// `[data-mantine-color-scheme="dark"]`-scoped override.
//
// SCOPE (honest): mounting the real 1900-line `ModelVersionDetails` in browser
// mode is disproportionate/brittle for a CSS change — it pulls ~20 hooks and
// ~50 child components (trpc, stores, contexts, ads, native/prisma pre-scan).
// That full mount is a not-yet-climbed "harder rung". Instead this test renders
// the EXACT DOM the converted rows now emit, using the REAL hashed `classes`
// compiled from the component's own `.module.scss`, and pins the visual contract
// via getComputedStyle in real Chromium:
//   * the labels + values still render and the row elements exist,
//   * each row reproduces the flex block `<Group>` produced + px="md"/py={10},
//   * the dimmed label matches `<Text size="sm" c="dimmed">` (span, sm, dimmed),
//   * the borders match the source ternary EXACTLY, verified under BOTH color
//     schemes (light => gray-3/gray-2, dark => dark-4/dark-5), proving the
//     light-dark substitution is equivalent to the removed
//     `colorScheme === 'dark' ? dark[N] : gray[M]` ternary — the one input that
//     could shift a pixel.
//
// The Mantine palette vars aren't injected in a bare browser test, so the module
// rules reference *undefined* vars there. We define SENTINEL values for exactly
// the vars asserted (distinct rgb per swatch), which makes every border/color/
// spacing assertion load-bearing (a mixed-up var => a different rgb => fail).
// What it does NOT pin: that `ModelVersionDetails` references these classes
// (guarded by the diff + `tsc`, not this test).
// =============================================================================

// Sentinel values for the exact CSS vars the converted classes consume. Distinct
// rgb per swatch so a wrong var (e.g. gray-3 vs dark-4, or the file gray-2/dark-5
// pair) resolves to a different color and the assertion fails.
const VARS: Record<string, string> = {
  '--mantine-color-gray-3': 'rgb(211, 211, 211)', // detail row border (light)
  '--mantine-color-dark-4': 'rgb(44, 46, 51)', //     detail row border (dark)
  '--mantine-color-gray-2': 'rgb(233, 236, 239)', //  file row border (light)
  '--mantine-color-dark-5': 'rgb(35, 37, 43)', //     file row border (dark)
  '--mantine-color-dimmed': 'rgb(134, 142, 150)', //  dimmed label color
  '--mantine-color-gray-0': 'rgb(248, 249, 250)', //  panel bg (light)
  '--mantine-font-size-sm': '13px', //                label font-size (size="sm")
  '--mantine-line-height-sm': '1.45',
  '--mantine-spacing-md': '16px', //                  px="md"
  '--mantine-spacing-sm': '12px', //                  file row p="sm"
};

const ROWS: Array<{ cls: string; label: string; value: string; testid: string }> = [
  { cls: classes.detailRow, label: 'Type', value: 'Checkpoint', testid: 'row-type' },
  { cls: classes.detailRow, label: 'Base Model', value: 'SDXL 1.0', testid: 'row-base' },
  { cls: classes.detailRowPlain, label: 'Hash', value: 'abc123', testid: 'row-hash' },
  { cls: classes.detailRowTop, label: 'Trigger Words', value: 'sks person', testid: 'row-trigger' },
  { cls: classes.detailRowTop, label: 'AIR', value: 'urn:air:sdxl', testid: 'row-air' },
];

function DetailsFixture({ scheme = 'light' as 'light' | 'dark' }) {
  return (
    <div
      data-testid="panel"
      data-mantine-color-scheme={scheme}
      className={classes.detailsPanel}
      style={VARS as React.CSSProperties}
    >
      {ROWS.map((r) => (
        <div className={r.cls} data-testid={r.testid} key={r.testid}>
          <span className={classes.detailLabel}>{r.label}</span>
          <span data-testid={`${r.testid}-value`}>{r.value}</span>
        </div>
      ))}
      {/* File / linked-component row wrapper (was `<Box p="sm" style={{border…}}>`). */}
      <div className={classes.fileRow} data-testid="file-row">
        <span data-testid="file-name">my-lora.safetensors</span>
      </div>
    </div>
  );
}

const cs = (el: Element) => getComputedStyle(el);
const q = (testid: string) => document.querySelector(`[data-testid="${testid}"]`) as HTMLElement;

describe('ModelVersionDetails — Details rows static-CSS conversion', () => {
  test('every row renders its label + value; the row exists; the label is a <span> detailLabel', async () => {
    renderWithProviders(<DetailsFixture />);

    // Anchor on an awaited element (browser render is async-committed).
    await expect.element(page.getByText('Type', { exact: true })).toBeInTheDocument();

    for (const r of ROWS) {
      await expect.element(page.getByText(r.label, { exact: true })).toBeInTheDocument();
      await expect.element(page.getByText(r.value, { exact: true })).toBeInTheDocument();

      const row = q(r.testid);
      expect(row, `row ${r.testid} exists`).toBeTruthy();
      expect(row.className).toContain(r.cls);
      // Converted label: a <span class=detailLabel>, NOT the old <Text>/<p>.
      const label = row.querySelector('span');
      expect(label?.tagName).toBe('SPAN');
      expect(label?.className).toContain(classes.detailLabel);
      expect(label?.textContent).toBe(r.label);
    }

    await expect.element(page.getByText('my-lora.safetensors', { exact: true })).toBeInTheDocument();
    expect(q('file-row')).toBeTruthy();
  });

  test('detail rows reproduce the Group flex layout + px="md"/py={10}; label == Text size="sm" c="dimmed"', async () => {
    renderWithProviders(<DetailsFixture />);
    await expect.element(page.getByText('Type', { exact: true })).toBeInTheDocument();

    for (const testid of ['row-type', 'row-hash', 'row-trigger']) {
      const s = cs(q(testid));
      expect(s.display, `${testid} display`).toBe('flex');
      expect(s.flexDirection).toBe('row');
      expect(s.flexWrap).toBe('wrap');
      expect(s.justifyContent).toBe('space-between');
      expect(s.alignItems).toBe('center');
      expect(s.rowGap === '16px' || s.columnGap === '16px').toBe(true); // gap: spacing-md
      expect(s.paddingTop).toBe('10px'); // py={10}
      expect(s.paddingBottom).toBe('10px');
      expect(s.paddingLeft).toBe('16px'); // px="md" == spacing-md sentinel
      expect(s.paddingRight).toBe('16px');
    }

    // Dimmed label matches `<Text size="sm" c="dimmed">`: dimmed color + sm font-size + normal weight.
    const label = cs(q('row-type').querySelector('span')!);
    expect(label.color).toBe('rgb(134, 142, 150)'); // --mantine-color-dimmed
    expect(label.fontSize).toBe('13px'); //            --mantine-font-size-sm
    expect(label.fontWeight).toBe('400'); //           font-weight: normal

    // File row wrapper reproduces `<Box p="sm">`: spacing-sm on every side.
    const file = cs(q('file-row'));
    expect(file.paddingLeft).toBe('12px');
    expect(file.paddingTop).toBe('12px');
    expect(file.paddingRight).toBe('12px');
    expect(file.paddingBottom).toBe('12px');
  });

  test('border side + color match the colorScheme ternary in BOTH schemes (light-dark parity)', async () => {
    const check = (scheme: 'light' | 'dark') => {
      const detailColor = scheme === 'dark' ? 'rgb(44, 46, 51)' : 'rgb(211, 211, 211)'; // dark[4] : gray[3]
      const fileColor = scheme === 'dark' ? 'rgb(35, 37, 43)' : 'rgb(233, 236, 239)'; //   dark[5] : gray[2]

      // .detailRow => 1px solid BOTTOM border, source-matched color; no top border.
      const detail = cs(q('row-type'));
      expect(detail.borderBottomStyle, `${scheme} detail style`).toBe('solid');
      expect(detail.borderBottomWidth).toBe('1px');
      expect(detail.borderBottomColor).toBe(detailColor);
      expect(detail.borderTopWidth).toBe('0px');

      // .detailRowTop => same color, border on TOP (Trigger Words / AIR); no bottom.
      const top = cs(q('row-trigger'));
      expect(top.borderTopStyle).toBe('solid');
      expect(top.borderTopWidth).toBe('1px');
      expect(top.borderTopColor).toBe(detailColor);
      expect(top.borderBottomWidth).toBe('0px');

      // .detailRowPlain => no border at all (Hash).
      const plain = cs(q('row-hash'));
      expect(plain.borderTopWidth).toBe('0px');
      expect(plain.borderBottomWidth).toBe('0px');

      // .fileRow => gray-2/dark-5 bottom border.
      const file = cs(q('file-row'));
      expect(file.borderBottomStyle).toBe('solid');
      expect(file.borderBottomWidth).toBe('1px');
      expect(file.borderBottomColor).toBe(fileColor);
    };

    renderWithProviders(<DetailsFixture scheme="light" />);
    await expect.element(page.getByText('Type', { exact: true })).toBeInTheDocument();
    check('light');

    // The dark border override is scoped to `[data-mantine-color-scheme="dark"] …`
    // on an ancestor — flip it live and the computed borders re-resolve to dark[N].
    q('panel').setAttribute('data-mantine-color-scheme', 'dark');
    check('dark');
  });
});
