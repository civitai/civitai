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
 * written and run in the browser `component` project, and it cannot work: with the fix in
 * place a checked `FilterChip` there computes `border-top-width: 0px` and
 * `border-top-style: none`, and both `--mantine-primary-color-filled` and
 * `--mantine-color-text` read as the EMPTY STRING on `:root` and on the label — so the
 * assertion fails identically whether the fix is present or absent. `MantineProvider`
 * does inject theme variables, but `deduplicateCssVariables` (default true) strips every
 * variable matching Mantine's default on the assumption `styles.css` is loaded, and the
 * harness loads only the `:root` properties parsed out of `globals.css`
 * (`test/component-setup.tsx`). The browser evidence for this change is the manual
 * measurement recorded above, not a suite.
 *
 * 🔴 EVERY ASSERTION HERE IS TEXTUAL. It reads source, not rendered CSS, so it can be
 * satisfied by text that does not have the claimed effect and can refuse a valid edit it
 * does not recognise. Where a message below sounds definite, it is describing what the
 * source says, not what a browser computed.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * The modules in THIS change's scope — five of the seven `.label` modules handed to a
 * Mantine `Chip`. NOT an inventory: `ImageGeneration/GenerationForm/ResourceSelectFilters`
 * and `PurchasableRewards/PurchasableRewardsModeratorFiltersDropdown` are the same copied
 * rule and are deliberately not listed, so a checked chip there still renders as a filled
 * pill. Add them here when they are brought into line.
 */
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
 * can trip a negative one with prose.
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
 * The `.label` rule body.
 *
 * 🔴 EVERYTHING BELOW IS SCOPED THROUGH THIS, DELIBERATELY. Searching a whole module for a
 * selector or a declaration reads decoys in unrelated rules — and a decoy that happens to
 * be compliant while `.label`'s own copy rots is the one failure mode in this file that
 * would not be loud.
 */
function labelBlock(src: string): string | null {
  return blockAt(src, src.search(/^\.label\s*\{/m));
}

/** The whole `&[data-checked]…` body, sibling rules included. */
function checkedBlock(label: string): string | null {
  return blockAt(label, label.indexOf('&[data-checked]'));
}

/**
 * The `&, &:hover` group inside it — where the pinned declarations live.
 *
 * 🔴 THE TWO SCOPES ARE NOT INTERCHANGEABLE, AND USING THIS ONE FOR THE COUNTS WAS A BUG.
 * Presence is asserted here, because this is where the declarations belong. Overrides are
 * counted over the whole checked body, because a SIBLING rule is a real override: a
 * `&:hover { background-color: var(--chip-bg); }` beside this group has the same specificity
 * and comes later, so it restores the filled background on hover — the headline bug of this
 * change, with every presence assertion still green.
 */
function checkedGroup(checked: string): string | null {
  return blockAt(checked, checked.search(/&\s*,\s*&:hover/));
}

/**
 * How many times any member of a shorthand family is declared.
 *
 * 🔴 THE FAMILY, NOT THE PROPERTY. `border: 1px solid …; border-width: 0;` overrides the
 * pinned value while leaving exactly one `border:` — and longhand override of a chip
 * border is a live idiom here (`StickerPlacementTray.tsx` does it inline, on purpose).
 * Counting only the exact property would miss the very shape this check exists for.
 */
function declarationCount(block: string, family: readonly string[]): number {
  return family.reduce((total, property) => {
    const re = new RegExp(`(^|[;{}\\s])${property.replace(/-/g, '\\-')}\\s*:`, 'g');
    return total + (block.match(re) ?? []).length;
  }, 0);
}

describe('filter chips render a visible border when checked', () => {
  it.each(CHIP_LABEL_MODULES)('%s', (relative) => {
    const src = code(read(path.join(REPO_ROOT, relative)));
    const label = labelBlock(src);
    expect(
      label,
      `${relative} no longer has a top-level \`.label\` rule — re-point this guard deliberately ` +
        'rather than letting it pass over a renamed selector.'
    ).not.toBeNull();

    // Asserted against the selector text, not against the file: the same substring appearing
    // on some unrelated rule would otherwise satisfy this while the scoping had moved.
    expect(
      /&\[data-checked\]:not\(\[data-disabled\]\)\s*\{/.test(label as string),
      `${relative} no longer excludes disabled chips from the checked rule. Mantine scopes every ` +
        'one of its own checked rules that way; unscoped, this clears the greyed disabled ' +
        'background too and a disabled checked chip reads as enabled. Keep the `:not()` on the ' +
        'checked selector rather than on `.label`, or the chip typography gets scoped behind it too.'
    ).toBe(true);

    const body = checkedBlock(label as string);
    expect(
      body,
      `${relative} no longer has an \`&[data-checked]\` block inside \`.label\` — re-point this ` +
        'guard deliberately rather than letting it pass over a renamed selector.'
    ).not.toBeNull();
    const checked = body as string;

    const group = checkedGroup(checked);
    expect(
      group,
      `${relative} no longer has an \`&, &:hover\` group inside \`&[data-checked]\` — the ` +
        'declarations below are read from that group, so this guard now checks nothing. Re-point it.'
    ).not.toBeNull();
    const pinned = group as string;

    expect(
      /border:\s*1px solid var\(--mantine-primary-color-filled\)\s*;/.test(pinned),
      `${relative} no longer draws the checked border from \`--mantine-primary-color-filled\`. ` +
        'If it names a different custom property, check that property is actually DEFINED: ' +
        '`--mantine-color-primary` was not, which made the whole shorthand invalid and drew no ' +
        'border at all.'
    ).toBe(true);

    expect(
      /background-color:\s*transparent\s*;/.test(pinned),
      `${relative} has no \`background-color: transparent\` in the checked group. If the fill is ` +
        'still there, the border above is the same colour as it and cannot be seen — the chip looks ' +
        'exactly as it did when the border was missing entirely. If you wrote the `background` ' +
        'shorthand instead, this guard pins the longhand spelling and needs updating deliberately.'
    ).toBe(true);

    expect(
      /(^|[;{}\s])color:\s*var\(--mantine-color-text\)\s*;/.test(pinned),
      `${relative} no longer pins the checked label colour. Mantine's own value is white, for ` +
        'the filled background this rule removes; without the override a checked chip in light ' +
        'mode is white text on transparent — an empty outlined pill.'
    ).toBe(true);

    expect(
      /--chip-icon-color:\s*var\(--mantine-primary-color-filled\)\s*;/.test(pinned),
      `${relative} no longer pins the check mark's colour. Mantine draws it from ` +
        '`--chip-color`, i.e. white — invisible once the fill is gone, exactly like the label ' +
        'colour above.'
    ).toBe(true);

    // 🔴 The dead selector, kept out by name. It is the plausible "fix" someone re-adds, and the
    // natural place to re-add it is as a SIBLING of the group above — so this reads the whole
    // checked body, not the group.
    expect(
      /\[data-variant/.test(checked),
      `${relative} matches on \`data-variant\` again. Mantine puts that attribute on the Chip ` +
        'ROOT, not on the label — such a clause matches nothing, which is exactly how the filled ' +
        'background survived here for as long as it did.'
    ).toBe(false);

    // 🔴 A SECOND DECLARATION IS HOW A REPAIRED RULE GOES BACK TO BEING INEFFECTIVE, and a
    // fragment match cannot see the cascade: `border: 1px solid var(…); border-width: 0;`
    // satisfies every assertion above while drawing nothing. That is this bug's own history —
    // a declaration present and overridden — so it is checked by count across the family.
    const families = {
      border: [
        'border',
        'border-width',
        'border-style',
        'border-color',
        'border-top',
        'border-right',
        'border-bottom',
        'border-left',
        'border-block',
        'border-inline',
      ],
      background: ['background', 'background-color'],
      color: ['color'],
    } as const;
    for (const [name, family] of Object.entries(families)) {
      const count = declarationCount(checked, family);
      expect(
        count,
        `${relative} declares ${name} ${count} times anywhere in the \`&[data-checked]\` block ` +
          `(counting ${family.join(', ')}), sibling rules included. The later one wins, so the ` +
          'pinned value above may not be what renders — a sibling `&:hover { background-color: … }` ' +
          'restores on hover exactly the fill this change removes. A second declaration may well be ' +
          'legitimate; if it is, widen this guard deliberately rather than deleting it.'
      ).toBe(1);
    }
  });

  /**
   * The LIBRARY half: the property the source half names has to exist. Pinned against the
   * installed package so a Mantine upgrade that drops it is caught HERE with an explanation.
   *
   * Scope note, so this claims no more than it proves: only the FIRST hop is asserted to be
   * unconditional. `--mantine-primary-color-filled` resolves to `--mantine-color-blue-filled`,
   * which Mantine defines per colour scheme and never unconditionally — that is by design
   * (`ColorSchemeScript` always sets the attribute), and it is not what this pins.
   */
  it('`--mantine-primary-color-filled` is defined on Mantine’s unconditional `:root`', () => {
    // Resolved here rather than at module scope: a tree without `node_modules` then fails this one
    // test instead of taking the whole file down as a collection error. The message in that case is
    // node's `MODULE_NOT_FOUND`, not `read`'s — the throw happens before the existence check.
    const mantineCss = createRequire(__filename).resolve('@mantine/core/styles.layer.css');
    const css = read(mantineCss);
    const root = blockAt(css, css.search(/:root\s*\{/));
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
   * 🔴 THE FIX RESTS ON CASCADE LAYERS, AND A LAYER BEATS ANY SPECIFICITY.
   * `postcss.config.js` wraps every `*.module.scss` in `@layer modules`, `_app.tsx` imports
   * Mantine's `styles.layer.css` (`@layer mantine`), and `_document.tsx` declares `modules`
   * AFTER `mantine`. The module rule also out-specifies Mantine's since it gained
   * `:not([data-disabled])` — (0,3,0) against (0,2,0) — but that is no defence: reorder the
   * declaration and the `mantine` layer wins regardless of specificity, restoring the filled
   * background with nothing else changing.
   *
   * That contract is repo-wide, not a filter-chip one — `globals.css` documents it as governing
   * every `*.module.scss`. This test and the one below it are currently its ONLY guards. The next
   * module-level fix that leans on it should MOVE them into a shared guard, not copy them.
   */
  it('the `modules` layer still outranks `mantine`, which is why these rules apply at all', () => {
    // Comment-stripped: `_document.tsx` already carries a commented-out element
    // (`{/* <InlineStylesHead /> */}`), so commenting this one out — what someone does while
    // debugging a layer problem — would otherwise leave a dead declaration satisfying this.
    const doc = code(read(path.join(REPO_ROOT, 'src/pages/_document.tsx')));
    // Matched on the string that SHIPS, not on the first `@layer` in the file: the comment above
    // that line quotes the declaration, and prose would otherwise satisfy this.
    const order = /__html:\s*'@layer ([^']+);'/.exec(doc);
    expect(
      order,
      'src/pages/_document.tsx no longer emits a `@layer` order via `__html`. Without that ' +
        'declaration the checked-chip rules fall back to layer order as encountered, which is not ' +
        'something anything in this repo controls.'
    ).not.toBeNull();
    const names = (order as RegExpExecArray)[1].split(',').map((n) => n.trim());
    // Membership before comparison: `indexOf` returns -1 for an absent name, so an ordering
    // assertion alone passes when `mantine` is simply gone.
    expect(names, `the declared layer order is [${names.join(', ')}]`).toContain('mantine');
    expect(names, `the declared layer order is [${names.join(', ')}]`).toContain('modules');
    expect(
      names.indexOf('modules'),
      `the declared layer order is [${names.join(
        ', '
      )}]. \`modules\` must come after \`mantine\`, ` +
        "or every checked filter chip goes back to Mantine's filled background and the border " +
        'becomes invisible again.'
    ).toBeGreaterThan(names.indexOf('mantine'));
  });

  /**
   * The other half of that: Mantine has to be IN a layer for the order to bind. Swapping this
   * one import for `@mantine/core/styles.css` leaves Mantine unlayered, and unlayered
   * declarations beat every named layer — so the filled background returns and the border goes
   * invisible again, with nothing else in the repo changing. It is a one-word edit of exactly
   * the kind someone makes while debugging a layer problem.
   */
  it('Mantine is imported as its LAYERED build', () => {
    const app = code(read(path.join(REPO_ROOT, 'src/pages/_app.tsx')));
    expect(
      /@mantine\/core\/styles\.layer\.css/.test(app),
      'src/pages/_app.tsx no longer imports `@mantine/core/styles.layer.css`. The unlayered ' +
        '`styles.css` build beats every layered rule, including the checked-chip rules in ' +
        '`*.module.scss`, so the filled background comes back and the border becomes invisible.'
    ).toBe(true);
    // 🔴 ADDING the unlayered build breaks this exactly as REPLACING it does, and a paste from
    // Mantine's docs adds rather than replaces. Anchored on `@mantine/core/` so the unrelated
    // `mantine-react-table/styles.css` import in the same file does not trip it.
    expect(
      /@mantine\/core\/styles\.css/.test(app),
      'src/pages/_app.tsx imports the UNLAYERED `@mantine/core/styles.css` as well. Unlayered ' +
        'declarations beat every named layer, so this restores the filled background on checked ' +
        'chips even with the layered build still imported beside it.'
    ).toBe(false);
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
    // qualified (`.label:not(…)`) or nested — rather than the one spelling it had. A descendant
    // form (`.wrap .label`) is not matched and would be equally unreachable style.
    expect(
      /(^|[,{}])\s*\.label\b/m.test(src),
      `${relative} has a \`.label\` rule again. Nothing applies it — the component passes only ` +
        'indicator/actionButton/opened classes to Mantine — so it is style that cannot render, and ' +
        'the last copy sat there broken alongside five live ones. If a chip in this file genuinely ' +
        'needs the class now, wire it up in the component in the same change.'
    ).toBe(false);
  });
});
