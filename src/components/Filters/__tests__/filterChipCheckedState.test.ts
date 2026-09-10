import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A CHECKED FILTER CHIP IS AN OUTLINE, NOT A FILLED PILL — AND THE BORDER HAS TO BE
 * VISIBLE, WHICH TAKES BOTH HALVES OF THIS FILE.
 *
 * Measured 2026-09-10 on `/models` → Filters → Time period, before the fix: the checked
 * chip drew NO border at all. The rule asked for `var(--mantine-color-primary)`, which is
 * defined nowhere — not in this repo and not in `@mantine/core` — so the `border`
 * shorthand was invalid at computed-value time, both longhands fell back to their initial
 * values (`border-style: none`, used width 0), and the checked chip rendered 2px narrower
 * than the unchecked one.
 *
 * 🔴 CORRECTING THE VARIABLE ALONE IS NOT ENOUGH, AND LOOKS LIKE IT IS. Beside the broken
 * line every module also carried `&[data-checked] { &[data-variant='filled'] {…} }`, and
 * Mantine puts `data-variant` on the Chip ROOT, not on the label these modules style — so
 * that clause never matched, the filled background survived, and a repaired border came
 * out `rgb(25,113,194)` on a background of exactly the same colour. A border that renders
 * and cannot be seen reads as a finished ticket while changing nothing anyone can
 * perceive. Hence the background assertion below: it is what makes the border assertion
 * mean something.
 *
 * 🔴 AND THE TEXT COLOUR IS LOAD-BEARING, NOT TIDYING. Mantine's checked rule sets
 * `color: var(--chip-color)` — white, chosen for the filled background this file removes.
 * Leave it and a checked chip in LIGHT mode is white text on a transparent background:
 * measured, an empty outlined pill with its label and check mark invisible. The explicit
 * `--mantine-color-text` is what keeps it readable (15.78:1 light, 8.48:1 dark).
 *
 * WHY A SOURCE GUARD RATHER THAN A RENDERED ONE. The browser `component` project loads
 * only the `:root` custom properties parsed out of `globals.css` (`test/component-setup.tsx`),
 * NOT `@mantine/core/styles.css` — so `--mantine-primary-color-filled` does not resolve
 * there and every Mantine class is styleless. A computed-colour assertion in that harness
 * would compare one unresolved value to another and pass while observing nothing. Same
 * split, and the same reasoning, as `AppBlocks/__tests__/chromeCrumbLinkStyle.test.ts`:
 * the source half is checked here, the library half against the installed package.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MANTINE_CSS = path.join(REPO_ROOT, 'node_modules/@mantine/core/styles.css');

/** The modules whose `.label` class is actually handed to a Mantine `Chip`. */
const CHIP_LABEL_MODULES = [
  'src/components/Filters/FilterChip.module.scss',
  'src/components/CosmeticShop/ShopFiltersDropdown.module.scss',
  'src/components/CosmeticShop/CosmeticsFiltersDropdown.module.scss',
  'src/components/Cosmetics/CosmeticsFiltersDropdown.module.scss',
  'src/components/Buzz/WithdrawalRequest/BuzzWithdrawalRequestFiltersDropdown.module.scss',
];

function read(file: string): string {
  // Prove the path before trusting a "no match": a search over an absent operand reports
  // CLEAN, not MISSING, so a moved file would turn every assertion below into a vacuous pass.
  expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip comments — every token searched for below is also discussed in the file it is sought in. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** The body of the `&[data-checked]` block inside `.label`. */
function checkedBlock(src: string): string | null {
  const at = src.indexOf('&[data-checked]');
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

describe('filter chips render a visible border when checked', () => {
  it.each(CHIP_LABEL_MODULES)('%s', (relative) => {
    const src = code(read(path.join(REPO_ROOT, relative)));
    const block = checkedBlock(src);
    expect(
      block,
      `${relative} no longer has a \`&[data-checked]\` block in its \`.label\` rule — ` +
        're-point this guard deliberately rather than letting it pass over a renamed selector.'
    ).not.toBeNull();

    expect(
      /border:\s*1px solid var\(--mantine-primary-color-filled\)/.test(block as string),
      `${relative} no longer draws the checked border from \`--mantine-primary-color-filled\`. ` +
        'If it names a different custom property, check that property is actually DEFINED: ' +
        '`--mantine-color-primary` was not, which made the whole shorthand invalid and drew no ' +
        'border at all.'
    ).toBe(true);

    expect(
      /background-color:\s*transparent/.test(block as string),
      `${relative} lets the checked chip keep Mantine's filled background. The border above is ` +
        'the same colour as that background, so it renders and cannot be seen — the chip looks ' +
        'exactly as it did when the border was missing entirely.'
    ).toBe(true);

    expect(
      /color:\s*var\(--mantine-color-text\)/.test(block as string),
      `${relative} no longer pins the checked label colour. Mantine's own value is white, for ` +
        'the filled background this rule removes; without the override a checked chip in light ' +
        'mode is white text on transparent — an empty outlined pill.'
    ).toBe(true);

    // 🔴 The dead selector, kept out by name. It is the plausible "fix" someone re-adds.
    expect(
      /\[data-variant/.test(block as string),
      `${relative} matches on \`data-variant\` again. Mantine puts that attribute on the Chip ` +
        'ROOT, not on the label — such a clause matches nothing, which is exactly how the filled ' +
        'background survived here for as long as it did.'
    ).toBe(false);
  });

  /**
   * The LIBRARY half: the property the source half names has to exist, or the shorthand is
   * invalid again and the border silently disappears. Pinned against the installed package
   * so a Mantine upgrade that drops it is caught HERE, with an explanation.
   */
  it('`--mantine-primary-color-filled` is a property Mantine actually defines', () => {
    const css = read(MANTINE_CSS);
    // Positive control on the extraction: if `:root` changed shape, the lookup below returns
    // nothing and the failure would name the property rather than the parse.
    expect(
      /:root\s*\{/.test(css),
      "Mantine no longer ships a bare `:root` rule — this guard's extraction is stale, not the claim."
    ).toBe(true);
    expect(
      /--mantine-primary-color-filled:\s*[^;]+;/.test(css),
      'Mantine no longer defines `--mantine-primary-color-filled`. Every checked filter chip now ' +
        'asks for an undefined custom property, which invalidates the whole `border` shorthand and ' +
        'draws no border — the original bug, returning through the library rather than the source.'
    ).toBe(true);
  });

  /**
   * `AdaptiveFiltersDropdown.module.scss` carried a sixth copy of the same broken rule, on a
   * `.label` class NOTHING reads — that file hands Mantine only `indicatorRoot`, `indicator`,
   * `actionButton` and `opened`. It was deleted rather than repaired. This pins that: an
   * unreachable copy of a rule is how the same mistake reached six files.
   */
  it('the dropdown shell keeps no unreachable copy of the chip rule', () => {
    const relative = 'src/components/Filters/AdaptiveFiltersDropdown.module.scss';
    const src = code(read(path.join(REPO_ROOT, relative)));
    expect(
      /^\.label\s*\{/m.test(src),
      `${relative} has a \`.label\` rule again. Nothing applies it — the component passes only ` +
        'indicator/actionButton/opened classes to Mantine — so it is style that cannot render, and ' +
        'the last copy sat there broken alongside five live ones. If a chip in this file genuinely ' +
        'needs the class now, wire it up in the component in the same change.'
    ).toBe(false);
  });
});
