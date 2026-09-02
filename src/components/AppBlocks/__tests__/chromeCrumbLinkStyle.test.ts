import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * THE APP-CHROME BREADCRUMB LINK USES THE SITE'S LINK IDIOM — themed colour, and a
 * resting underline it keeps on purpose.
 *
 * 🔴 WHY THIS IS A NODE-TIER SOURCE + LIBRARY GUARD RATHER THAN A RENDERED ONE. The
 * natural test is "render the crumb and read its computed colour", and it cannot be
 * written: the browser `component` project loads only the `:root` custom properties
 * parsed out of `globals.css` (`test/component-setup.tsx`), NOT
 * `@mantine/core/styles.css` — so `--mantine-color-anchor` does not resolve there and
 * every Mantine class is styleless. A computed-colour assertion in that harness would
 * compare one unresolved value to another and pass while observing nothing, which is
 * the reassuring-zero shape. The claim is split instead into the two halves that CAN
 * each be checked exactly:
 *
 *   1. the crumb asks for the site's link treatment and adds no local override (source)
 *   2. the site's link treatment resolves to the audited shade (the shipped library)
 *
 * Together those are the claim. Neither half alone is.
 *
 * 🔴 AND IT IS IN THE GATING TIER, WHICH THE RENDERED ONE WOULD NOT HAVE BEEN. The
 * browser project runs in CI as the REPORT-ONLY `preview / component-tests` status, so
 * nothing there can block a merge; the node `unit` project can. Same split, and the same
 * reasoning, as `pageBlockHostMaxWidth.test.ts`.
 *
 * HISTORY THIS PROTECTS. The crumb used to carry `c="blue.6" td="underline"` — a
 * hand-rolled colour and decoration. The `blue.6` was not arbitrary: an audit found
 * the original `blue.4` worse against the near-white light chrome surface and bumped
 * it. Adopting the shared `Anchor` had to land on the same shade, and the reason it
 * does is a fact about Mantine that lives in Mantine — which is why it is asserted
 * against the installed package rather than restated in a comment.
 *
 * 🔴 DO NOT DESCRIBE blue-6 AS "THE WCAG AA SHADE" — MEASURED, IT IS NOT, AND AN
 * EARLIER VERSION OF THIS HEADER SAID SO. On this bar's light background
 * (`--mantine-color-default-hover` → gray-0 `#f8f9fa`) blue-6 `#228be6` is **3.37:1**,
 * against the 4.5:1 AA wants for the crumb's 12px text. The audit's bump improved it
 * without reaching AA. That shortfall PRE-DATES the move to `Anchor` and is untouched
 * by it — this file pins which shade renders, and deliberately makes no AA claim about
 * it. (The dark side is the one that genuinely improved: 3.82:1 → 5.49:1, failing → passing.)
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHROME = path.join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx');
const MANTINE_CSS = path.join(REPO_ROOT, 'node_modules/@mantine/core/styles.css');
const THEME = path.join(REPO_ROOT, 'src/providers/ThemeProvider.tsx');

function read(file: string): string {
  // Prove the path before trusting a "no match": a comparison against an absent
  // operand reports SAME, not MISSING, so a moved file would otherwise turn every
  // assertion below into a vacuous pass over an empty string.
  expect(fs.existsSync(file), `${file} does not exist`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/** Strip comments so a rule can never be satisfied by prose ABOUT the rule — every
 *  token searched for below is also discussed at length in the file it is sought in. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * The value of `prop` inside the rule whose selector begins at `at`.
 *
 * Deliberately a scan rather than a CSS parser: every property this file reads lives in
 * one of three flat, top-level rules, and a parser here would be more machinery than the
 * claim needs. Returns null when absent so a caller can fail with a message about the
 * PARSE rather than silently comparing against `undefined`.
 */
function varInRuleAt(css: string, at: number, prop: string): string | null {
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) return null;
  const body = css.slice(open + 1, close);
  const m = new RegExp(`${prop.replace(/-/g, '\\-')}\\s*:\\s*([^;]+);`).exec(body);
  return m ? m[1].trim() : null;
}

/** `prop` inside `:root[data-mantine-color-scheme='<scheme>']`. */
function schemeVar(css: string, scheme: 'light' | 'dark', prop: string): string | null {
  return varInRuleAt(css, css.indexOf(`:root[data-mantine-color-scheme='${scheme}']`), prop);
}

/**
 * `prop` inside the BARE `:root` rule — the scheme-independent defaults.
 *
 * 🔴 `indexOf(':root')` WOULD BE WRONG AND WOULD LOOK RIGHT: the scheme rules start with
 * the same five characters, so a plain search can land on `:root[data-…]` and read the
 * wrong rule while reporting a perfectly plausible value. The lookahead is what keeps
 * "the default" and "the light override" from being confused for one another — and they
 * are different rules holding different halves of the chain below.
 */
function rootVar(css: string, prop: string): string | null {
  return varInRuleAt(css, css.search(/:root\s*\{/), prop);
}

describe('the app-chrome breadcrumb link uses the site link idiom, at the audited shade', () => {
  /**
   * The SOURCE half. `Anchor` is what every other link on the site is; the two props
   * removed here are what made this one a fork. Both are checked by absence, so this
   * fails the moment someone re-adds a local colour or decoration "just for the chrome".
   */
  it('the "Marketplace" crumb is an `Anchor` and adds no local colour or decoration', () => {
    const src = code(read(CHROME));
    const at = src.indexOf('data-testid="app-block-breadcrumb-apps"');
    expect(
      at,
      'the breadcrumb crumb testid was not found in IframeHost.tsx — re-point this guard ' +
        'deliberately rather than letting it pass over a renamed element.'
    ).toBeGreaterThan(-1);

    // The element that OPENS before the testid: read back to the nearest `<`.
    const open = src.lastIndexOf('<', at);
    const element = src.slice(open, src.indexOf('>', at) + 1);

    expect(
      element,
      'the "Marketplace" crumb is no longer rendered with the site\'s `Anchor`. If it went ' +
        'back to a hand-styled `Text component={Link}`, the chrome has re-forked the link ' +
        'idiom this guard exists to keep unified.'
    ).toContain('<Anchor');

    // 🔴 BOTH ARE CHECKED, AND THE SECOND IS THE ONE THAT WOULD SLIP BACK. A local `c=`
    // re-pins the shade and silently un-does the dark-mode half of the fix (the old fixed
    // `blue.6` was only ever reasoned about against the LIGHT background); a local `td=`
    // restores the permanent underline nothing else on the site has.
    expect(
      /\sc=["{]/.test(element),
      'the crumb hard-codes a colour again (`c=…`). The point of using `Anchor` is that the ' +
        'link colour comes from the theme and therefore tracks the colour scheme; a local ' +
        'override pins one shade for both schemes, which is the bug this replaced.'
    ).toBe(false);
    expect(
      /\std=["{]/.test(element),
      'the crumb hard-codes a text-decoration again (`td=…`). The decoration is chosen with ' +
        "`Anchor`'s own `underline` prop, asserted below."
    ).toBe(false);

    // 🔴 `underline="always"` IS LOAD-BEARING AND IS NOT THE LIBRARY DEFAULT. Dropping it
    // reads as "adopt the default" and is a WCAG 1.4.1 (F73) Level-A regression: this
    // crumb's neighbours are dimmed, so at rest hue would be the only differentiator —
    // 1.07:1 on light, 1.29:1 on dark, where colour alone is permitted only above 3:1, and
    // Mantine emits its underline for `:hover`/`:active` with no `:focus-visible` fallback.
    // Five other call sites in this repo use the same prop for the same reason.
    expect(
      /\sunderline="always"/.test(element),
      'the crumb lost `underline="always"`. `Anchor` then falls back to `underline="hover"`, ' +
        'leaving colour as the sole resting cue against dimmed neighbours at 1.07:1 — WCAG ' +
        '1.4.1 failure F73. If this is intentional, the resting cue has to come from ' +
        'somewhere else and this guard should be re-pointed at it, not deleted.'
    ).toBe(true);
  });

  /**
   * The LIBRARY half — the fact the source half leans on, pinned against the installed
   * package so a Mantine upgrade that re-maps the anchor colour is caught HERE, with an
   * explanation, rather than as an unexplained contrast regression on a live page.
   *
   * 🔴 THE LIGHT ROW IS THE AUDIT'S OWN FINDING. `--mantine-color-anchor` resolving to
   * `--mantine-primary-color-filled`, and that resolving to blue-6, is precisely why
   * dropping the hard-coded `c="blue.6"` did not change a single rendered pixel on the
   * light chrome surface. If this assertion ever goes red, the crumb's contrast has to
   * be re-argued before the upgrade ships — it does not mean "update the expectation".
   */
  it('Mantine maps `--mantine-color-anchor` to blue-6 on light (the audited shade) and blue-4 on dark', () => {
    const css = read(MANTINE_CSS);
    // Positive control on the extraction: if the selector shape changed, every lookup
    // below returns null and the failures would name the colour rather than the parse.
    expect(
      css.includes(":root[data-mantine-color-scheme='light']"),
      "Mantine no longer ships a `:root[data-mantine-color-scheme='light']` rule — this " +
        "guard's extraction is stale, not the colour claim."
    ).toBe(true);

    // 🔴 THE CHAIN IS WALKED TO A HEX, NOT STOPPED AT THE FIRST `var()`. Asserting only
    // that the anchor points at `--mantine-primary-color-filled` would stay green through
    // a re-point of any LATER link, which is where the shade actually lives — the claim
    // that matters is the endpoint, so each hop is resolved and the final colour named.
    // Note the hops sit in DIFFERENT rules: the anchor and the blue-`filled` alias are
    // per-scheme, the primary-colour alias and the palette itself are scheme-independent.
    expect(schemeVar(css, 'light', '--mantine-color-anchor')).toBe(
      'var(--mantine-primary-color-filled)'
    );
    expect(rootVar(css, '--mantine-primary-color-filled')).toBe('var(--mantine-color-blue-filled)');
    expect(
      schemeVar(css, 'light', '--mantine-color-blue-filled'),
      'the light-scheme anchor colour no longer resolves to blue-6. The app-chrome ' +
        'breadcrumb inherited that exact shade from this chain when it stopped hard-coding ' +
        '`blue.6`, which is what made the swap pixel-neutral on light; re-derive the crumb ' +
        'colour and re-measure its contrast before accepting this. (Note blue-6 does NOT ' +
        'clear AA on this bar — 3.37:1 measured, against 4.5:1 for 12px text — so a change ' +
        'here is not bounded by "it was fine before".)'
    ).toBe('var(--mantine-color-blue-6)');
    expect(
      rootVar(css, '--mantine-color-blue-6'),
      'blue-6 is no longer #228be6 — the exact colour the contrast audit measured against ' +
        'the light chrome surface. Re-measure before accepting.'
    ).toBe('#228be6');

    // The dark row is the half the old hard-coded shade got WRONG — it kept the darker
    // blue-6 on a dark surface. Pinned so the improvement cannot be silently reverted.
    expect(
      schemeVar(css, 'dark', '--mantine-color-anchor'),
      'the dark-scheme anchor colour is no longer blue-4. The chrome crumb relies on the ' +
        'theme to go LIGHTER on a dark surface; pinning it back to a dark shade is the ' +
        'regression the move to `Anchor` fixed.'
    ).toBe('var(--mantine-color-blue-4)');
    expect(rootVar(css, '--mantine-color-blue-4')).toBe('#4dabf7');

    // 🔴 THE LIBRARY'S DEFAULTS ONLY DECIDE THE RENDERED COLOUR WHILE THIS APP LEAVES THEM
    // ALONE — and without the next three assertions this guard's headline would be wider
    // than what it checks. Measured: setting `primaryColor: 'orange'` and lightening
    // `blue[6]` in ThemeProvider changes the crumb's rendered colour outright while every
    // assertion above stays green, because none of them can see this app's theme.
    //
    // `createTheme` resolves `--mantine-color-anchor` through the PRIMARY colour and the
    // app's own `blue` scale, so an override of either re-points the whole chain. Read as
    // source rather than by importing the theme: importing pulls @mantine/core into the
    // node tier for a question that is answered by three literals.
    const theme = code(read(THEME));
    expect(
      /primaryColor\s*:/.test(theme),
      'ThemeProvider now sets `primaryColor`. The chrome crumb takes its colour from ' +
        '`--mantine-color-anchor`, which resolves through the PRIMARY colour on light — so ' +
        'the blue-6 chain asserted above is no longer what renders. Re-derive the crumb ' +
        'colour and re-point this guard.'
    ).toBe(false);
    expect(
      /primaryShade\s*:/.test(theme),
      'ThemeProvider now sets `primaryShade`, which moves which shade `filled` resolves to ' +
        'and therefore what the crumb renders on light.'
    ).toBe(false);
    // The app DOES restate Mantine's `blue` scale, so what matters is that the two shades
    // the chain lands on still hold the library's values. Read by INDEX, not by "appears
    // somewhere in the file" — the palette contains ten hexes and a containment check would
    // be satisfied by the right colour sitting at the wrong position. Compared
    // case-insensitively: this file writes `#228BE6`, the stylesheet `#228be6`, and a
    // case-sensitive compare would fail for the spelling rather than for the colour.
    const blue = /\bblue\s*:\s*\[([^\]]*)\]/.exec(theme)?.[1];
    expect(
      blue,
      "ThemeProvider's `blue` palette could not be parsed — re-point this guard"
    ).toBeDefined();
    const shades = [...blue!.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map((m) => m[1].toLowerCase());
    expect(shades, "ThemeProvider's `blue` is not a 10-shade tuple").toHaveLength(10);
    expect(
      shades[6],
      'ThemeProvider overrides `blue[6]`, the shade the crumb renders on LIGHT. The library ' +
        'chain asserted above is no longer what ships — re-derive the crumb colour and its ' +
        'contrast against the app theme.'
    ).toBe('#228be6');
    expect(
      shades[4],
      'ThemeProvider overrides `blue[4]`, the shade the crumb renders on DARK.'
    ).toBe('#4dabf7');

    // 🔴 THE DISCRIMINATOR, AND THE REASON THE SWAP IS AN IMPROVEMENT RATHER THAN A WASH.
    // The whole argument is that the themed colour MOVES with the scheme where the old
    // hard-coded `blue.6` did not. If these two were ever equal, `Anchor` would be
    // buying nothing over the fixed shade and this guard would be asserting a
    // distinction that no longer exists.
    expect(rootVar(css, '--mantine-color-blue-6')).not.toBe(rootVar(css, '--mantine-color-blue-4'));
  });
});
