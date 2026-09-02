import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * THE APP-CHROME BREADCRUMB LINK USES THE SITE'S LINK IDIOM — and the WCAG AA shade
 * the contrast audit settled on is still what renders.
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
 * one-off link style bluer and more underlined than anything else on the site. The
 * `blue.6` was not arbitrary: an audit found the original `blue.4` borderline against
 * the near-white light chrome surface and bumped it. Adopting the shared `Anchor` had
 * to preserve that, and the reason it does is a fact about Mantine that lives in
 * Mantine, not here — which is exactly why it is asserted against the installed
 * package instead of restated in a comment.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHROME = path.join(REPO_ROOT, 'src/components/AppBlocks/IframeHost.tsx');
const MANTINE_CSS = path.join(REPO_ROOT, 'node_modules/@mantine/core/styles.css');

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
      'the crumb hard-codes a text-decoration again (`td=…`). `Anchor` defaults to ' +
        'underline-on-hover, which is the site idiom.'
    ).toBe(false);
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
        'breadcrumb inherited its WCAG AA contrast from that chain when it stopped ' +
        'hard-coding `blue.6`; re-check the crumb against the light chrome surface before ' +
        'accepting this.'
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

    // 🔴 THE DISCRIMINATOR, AND THE REASON THE SWAP IS AN IMPROVEMENT RATHER THAN A WASH.
    // The whole argument is that the themed colour MOVES with the scheme where the old
    // hard-coded `blue.6` did not. If these two were ever equal, `Anchor` would be
    // buying nothing over the fixed shade and this guard would be asserting a
    // distinction that no longer exists.
    expect(rootVar(css, '--mantine-color-blue-6')).not.toBe(rootVar(css, '--mantine-color-blue-4'));
  });
});
