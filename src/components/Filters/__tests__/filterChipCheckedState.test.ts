import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * A CHECKED FILTER CHIP IS AN OUTLINE, NOT A FILLED PILL — AND THE BORDER HAS TO BE
 * VISIBLE, WHICH TAKES ALL THREE DECLARATIONS THIS FILE PINS.
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
 * perceive. Hence the background assertion: it is what makes the border assertion mean
 * something.
 *
 * 🔴 AND THE TEXT COLOUR IS LOAD-BEARING, NOT TIDYING. Mantine's checked rule sets
 * `color: var(--chip-color)` — white, chosen for the filled background this file removes.
 * Leave it and a checked chip in LIGHT mode is white text on a transparent background:
 * measured, an empty outlined pill with its label and check mark invisible. The explicit
 * `--mantine-color-text` is what keeps it readable (15.78:1 light, 8.48:1 dark), and
 * `--chip-icon-color` does the same job for the check mark, which Mantine also draws white.
 *
 * WHY THIS IS A SOURCE GUARD, MEASURED RATHER THAN ASSUMED. A rendered version was
 * written and run in the browser `component` project, and it cannot work: that harness
 * loads neither `@mantine/core/styles.css` nor Mantine's runtime theme variables. With
 * the fix in place, a checked `FilterChip` there computes `border-top-width: 0px`,
 * `border-top-style: none`, and BOTH `--mantine-primary-color-filled` and
 * `--mantine-color-text` read as the empty string on `:root` and on the label. So the
 * rendered assertion fails identically whether the fix is present or absent — it
 * distinguishes nothing. (`test/component-setup.tsx` injects only the `:root` custom
 * properties parsed out of `globals.css`.) The browser evidence for this change is the
 * manual measurement recorded above, not a suite.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
// Resolved through node rather than joined onto REPO_ROOT: pnpm's layout is a symlink
// farm, and a hand-built path is the thing that goes stale when a worktree is laid out
// differently from the primary checkout.
// `styles.layer.css`, not `styles.css`: that is the build the app imports
// (`src/pages/_app.tsx`), and the layered one is what the cascade claim below rests on.
const MANTINE_CSS = createRequire(__filename).resolve('@mantine/core/styles.layer.css');

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

/**
 * Strip comments — every token searched for below is also discussed in the file it is
 * sought in. Trailing `//` comments are stripped too, not just full-line ones: a trailing
 * comment can otherwise satisfy a positive assertion whose declaration was deleted, and
 * can trip the negative one with prose.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

/** The body of `rule { … }` starting at `at`, brace-matched. Null when unbalanced. */
function blockAt(src: string, at: number): string | null {
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

/**
 * The `&[data-checked]` body inside the `.label` rule.
 *
 * 🔴 SCOPED TO `.label` FIRST, DELIBERATELY. Searching the whole file for the first
 * `&[data-checked]` would read a decoy in any rule above it — and if that decoy happened
 * to be compliant while `.label`'s own copy rotted, the pass would be silent. This is the
 * one failure mode in the file that would not be loud.
 */
function checkedBlock(src: string): string | null {
  const label = blockAt(src, src.search(/^\.label\s*\{/m));
  if (label === null) return null;
  return blockAt(label, label.indexOf('&[data-checked]'));
}

/** How many times a property is declared — `color:` must not match `background-color:`. */
function declarationCount(block: string, property: string): number {
  const re = new RegExp(`(^|[;{}\\s])${property.replace(/-/g, '\\-')}\\s*:`, 'g');
  return (block.match(re) ?? []).length;
}

describe('filter chips render a visible border when checked', () => {
  it.each(CHIP_LABEL_MODULES)('%s', (relative) => {
    const src = code(read(path.join(REPO_ROOT, relative)));
    const block = checkedBlock(src);
    expect(
      block,
      `${relative} no longer has a \`&[data-checked]\` block inside its \`.label\` rule — ` +
        're-point this guard deliberately rather than letting it pass over a renamed selector.'
    ).not.toBeNull();
    const checked = block as string;

    expect(
      /border:\s*1px solid var\(--mantine-primary-color-filled\)\s*;/.test(checked),
      `${relative} no longer draws the checked border from \`--mantine-primary-color-filled\`. ` +
        'If it names a different custom property, check that property is actually DEFINED: ' +
        '`--mantine-color-primary` was not, which made the whole shorthand invalid and drew no ' +
        'border at all.'
    ).toBe(true);

    expect(
      /background-color:\s*transparent\s*;/.test(checked),
      `${relative} lets the checked chip keep Mantine's filled background. The border above is ` +
        'the same colour as that background, so it renders and cannot be seen — the chip looks ' +
        'exactly as it did when the border was missing entirely.'
    ).toBe(true);

    expect(
      /(^|[;{}\s])color:\s*var\(--mantine-color-text\)\s*;/.test(checked),
      `${relative} no longer pins the checked label colour. Mantine's own value is white, for ` +
        'the filled background this rule removes; without the override a checked chip in light ' +
        'mode is white text on transparent — an empty outlined pill.'
    ).toBe(true);

    expect(
      /--chip-icon-color:\s*var\(--mantine-primary-color-filled\)\s*;/.test(checked),
      `${relative} no longer pins the check mark's colour. Mantine draws it from ` +
        '`--chip-color`, i.e. white — invisible once the fill is gone, exactly like the label ' +
        'colour above.'
    ).toBe(true);

    // 🔴 A SECOND DECLARATION IS HOW A REPAIRED RULE GOES BACK TO BEING INEFFECTIVE, and a
    // fragment match cannot see the cascade: `border: 1px solid var(…); border: none;`
    // satisfies every assertion above while drawing nothing. That is this bug's own history
    // — a declaration present and overridden — so it is checked by count, not by presence.
    for (const property of ['border', 'background-color', 'color'] as const) {
      const count = declarationCount(checked, property);
      expect(
        count,
        `${relative} declares \`${property}\` ${count} times in the checked block. The later one ` +
          'wins, so the pinned value above may not be what renders. Keep one declaration per ' +
          'property here.'
      ).toBe(1);
    }

    expect(
      /:not\(\[data-disabled\]\)/.test(src),
      `${relative} no longer excludes disabled chips from the checked rule. Mantine scopes every ` +
        'one of its own checked rules with `:not([data-disabled])`; unscoped, this clears the ' +
        'greyed disabled background too and a disabled checked chip reads as enabled.'
    ).toBe(true);

    // 🔴 The dead selector, kept out by name. It is the plausible "fix" someone re-adds.
    expect(
      /\[data-variant/.test(checked),
      `${relative} matches on \`data-variant\` again. Mantine puts that attribute on the Chip ` +
        'ROOT, not on the label — such a clause matches nothing, which is exactly how the filled ' +
        'background survived here for as long as it did.'
    ).toBe(false);
  });

  /**
   * The LIBRARY half: the property the source half names has to exist, and has to exist
   * UNCONDITIONALLY. Pinned against the installed package so a Mantine upgrade that drops it,
   * or moves it behind a colour scheme, is caught HERE with an explanation.
   */
  it('`--mantine-primary-color-filled` is defined on Mantine’s unconditional `:root`', () => {
    const css = read(MANTINE_CSS);
    const root = blockAt(css, css.search(/:root\s*\{/));
    // The control is real only because the assertion below reads THIS slice: an unscoped
    // search over the whole file would stay green if the definition moved into a
    // scheme-specific or @media rule, which is the failure that would cost light mode its
    // border again.
    expect(
      root,
      "Mantine no longer ships a bare `:root` rule — this guard's extraction is stale, not the claim."
    ).not.toBeNull();
    expect(
      /--mantine-primary-color-filled:\s*[^;]+;/.test(root as string),
      'Mantine no longer defines `--mantine-primary-color-filled` on its unconditional `:root`. ' +
        'Every checked filter chip now asks for a property that may not resolve, which invalidates ' +
        'the whole `border` shorthand and draws no border — the original bug, returning through the ' +
        'library rather than the source.'
    ).toBe(true);
  });

  /**
   * 🔴 THE WHOLE FIX RESTS ON CASCADE LAYERS, AND SPECIFICITY IS A TIE UNDERNEATH.
   * `.label[data-checked]` and Mantine's `.m_fa109255:not([data-disabled]):where([data-checked])`
   * are both (0,2,0). What makes the module win is that `postcss.config.js` wraps every
   * `*.module.scss` in `@layer modules`, `_app.tsx` imports Mantine's `styles.layer.css`
   * (`@layer mantine`), and `_document.tsx` declares `modules` AFTER `mantine`. Remove or
   * reorder that declaration and these five rules lose to Mantine on source order — a coin
   * flip that would restore the filled background with nothing else changing.
   */
  it('the `modules` layer still outranks `mantine`, which is why these rules apply at all', () => {
    const doc = read(path.join(REPO_ROOT, 'src/pages/_document.tsx'));
    const order = /@layer ([a-z-]+(?:,\s*[a-z-]+)*);/.exec(doc);
    expect(
      order,
      'src/pages/_document.tsx no longer declares a `@layer` order. Without it the checked-chip ' +
        'rules below fall back to source order against Mantine, which is not something anything ' +
        'in this repo controls.'
    ).not.toBeNull();
    const names = (order as RegExpExecArray)[1].split(',').map((n) => n.trim());
    expect(
      names.indexOf('modules'),
      `the declared layer order is [${names.join(
        ', '
      )}]. \`modules\` must come after \`mantine\`, ` +
        "or every checked filter chip goes back to Mantine's filled background and the border " +
        'becomes invisible again.'
    ).toBeGreaterThan(names.indexOf('mantine'));
    expect(names).toContain('mantine');
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
    // Matches the class wherever a selector could reintroduce it — grouped (`.label, .x`),
    // qualified (`.label:not(…)`) or nested — rather than the one spelling it had.
    expect(
      /(^|[,{}])\s*\.label\b/m.test(src),
      `${relative} has a \`.label\` rule again. Nothing applies it — the component passes only ` +
        'indicator/actionButton/opened classes to Mantine — so it is style that cannot render, and ' +
        'the last copy sat there broken alongside five live ones. If a chip in this file genuinely ' +
        'needs the class now, wire it up in the component in the same change.'
    ).toBe(false);
  });
});
