import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { BUZZ_PER_USD_CENT, buzzAmountToUnitAmount } from '~/shared/utils/buzz-charge';

/**
 * THE SEAM GUARD for the Buzz-to-cents derivation.
 *
 * `buzz-charge.test.ts` covers the helper hermetically. That suite is blind to the defect that
 * actually shipped, because the defect is not IN the helper — it is whether the value handed to
 * `stripe.getPaymentIntent` was produced BY it.
 *
 * Measured: reverting the purchase form's call site to `/ 10` re-introduces the production bug and
 * leaves the helper suite, the schema suite and both stripe service suites green. Nothing else in
 * the repo catches it. With `.int()` now on `paymentIntentCreationSchema.unitAmount` that revert is
 * worse than the original defect — instead of 500ing at Stripe, a non-multiple-of-ten Buzz amount
 * is rejected at our own trust boundary, so Pay Now fails outright.
 *
 * 🔴 WHAT THIS GUARD ANCHORS ON, AND WHY IT MOVED IN ROUND 3.
 * Round 2's version keyed on `setCustomAmount(...)` call sites. A delta audit defeated it with two
 * one-line mutants that both put the bug back:
 *   - a parenthesised sub-expression between the setter's open paren and the division, which the
 *     old `[^)]*` character class could not cross; and
 *   - rewriting the WIRE VALUE at `const unitAmount = ...` directly, leaving both helper call
 *     sites intact so the call-count ledger stayed satisfied.
 * The lesson is that the call sites are not the seam — the single expression whose value reaches
 * the payment intent is. So this pins THAT expression verbatim, and separately asserts that the
 * live form contains no open-coded cents division at all. A guard that enumerates call sites can
 * always be walked around by adding one more; a guard that pins the one value that leaves the
 * component cannot.
 *
 * It is a SOURCE-TEXT guard by necessity: the derivation lives inside a ~1,200-line Mantine
 * component whose handlers cannot be invoked without mounting the whole purchase form.
 * `buzz-charge.test.ts` carries the behavioural half.
 */

const REPO = process.cwd();
const FORM_REL = 'src/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.tsx';
const FORM = path.join(REPO, FORM_REL);
const STRIPE_SERVICE = path.join(REPO, 'src/server/services/stripe.service.ts');
const HELPER = path.join(REPO, 'src/shared/utils/buzz-charge.ts');

/**
 * The legacy purchase component. It open-codes the derivation twice and is NOT fixed here because
 * it is dead — asserted below rather than assumed, so that if anything ever imports it again this
 * guard fails instead of silently tolerating a second live derivation.
 */
const DEAD_LEGACY_REL = 'src/components/Buzz/BuzzPurchase.tsx';

/**
 * Strip block comments and line comments, INCLUDING trailing ones.
 *
 * Round 2's version stripped only whole-line `//` comments while claiming to strip all of them, so
 * behaviour-correct code carrying a trailing comment could fail the guard and a trailing comment
 * could satisfy a required count. `[^\n]` before the `//` keeps this from eating the `//` in a URL
 * only when it follows a colon, which is the case that occurs in this corpus.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

/** Every `.ts`/`.tsx` file under `src/`, excluding tests. */
function walkSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, acc);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('the value handed to getPaymentIntent comes from the helper', () => {
  it('pins the wire-value derivation verbatim', () => {
    const code = stripComments(readFileSync(FORM, 'utf-8'));

    // The ONE expression whose value reaches `stripe.getPaymentIntent`. Pinned whole, normalised
    // for whitespace: it may come only from a selected package's price or from `customAmount`,
    // and `customAmount` is only ever written by the helper (asserted below). Any edit here —
    // including one that derives cents from the raw Buzz field — fails.
    const normalised = code.replace(/\s+/g, ' ');
    expect(normalised).toContain(
      'const unitAmount = (selectedPrice?.unitAmount ?? customAmount) as number;'
    );
  });

  it('has no open-coded cents division anywhere in the live form', () => {
    const code = stripComments(readFileSync(FORM, 'utf-8'));

    // Not scoped to a setter. Round 2's setter-scoped regex had a parenthesis hole; this one asks
    // the simpler question — does this file divide by the Buzz ratio at all? After the round-3 fix
    // to the min-amount placeholder the answer is no, so the expected count is ZERO and any
    // reintroduction in any shape fails. Tailwind class strings like `dark:border-white/10` are
    // excluded by requiring the divisor to end the token.
    const divisions = code.match(/\/\s*(?:10|BUZZ_PER_USD_CENT)\b(?!\s*[\w/-])/g) ?? [];
    expect(divisions).toEqual([]);
  });

  it('routes every cents derivation through the helper', () => {
    const code = stripComments(readFileSync(FORM, 'utf-8'));

    // EXACT, not `>=`. A `toBeGreaterThanOrEqual(2)` here let a mutant that simply DELETES one
    // call site survive, because three sites minus one still satisfies it — caught by this
    // round's own battery, which is the whole reason the count is pinned rather than bounded.
    // The three live derivations: the min-amount seed, the min-amount placeholder, and the
    // free-typed Buzz field. Fails when the set SHRINKS (a derivation stopped using the helper)
    // and when it GROWS (a new one this guard has never been pointed at).
    expect((code.match(/buzzAmountToUnitAmount\(/g) ?? []).length).toBe(3);
    expect(code).toMatch(
      /import\s*\{[^}]*\bbuzzAmountToUnitAmount\b[^}]*\}\s*from\s*'~\/shared\/utils\/buzz-charge'/
    );
  });

  it('allows the inverse derivation in either spelling', () => {
    const code = stripComments(readFileSync(FORM, 'utf-8'));
    // The USD field multiplies to get Buzz; that direction cannot produce a fraction. Round 2
    // hardcoded `* 10` here, which turned the guard RED on the correct single-sourcing change to
    // `* BUZZ_PER_USD_CENT` — telling a developer they had open-coded something when they had just
    // stopped doing so. Both spellings are accepted.
    expect(code).toMatch(
      /setCustomBuzzAmount\(\s*newCustomAmount\s*\*\s*(10|BUZZ_PER_USD_CENT)\s*\)/
    );
  });
});

describe('the helper has exactly one live importer', () => {
  it('discovers importers by walking src/, not by re-reading a fixed list', () => {
    // Round 2 "asserted the set" by filtering the expected list against itself, so it could only
    // ever shrink — a NEW importer with an open-coded division passed silently. This walks.
    const importers = walkSources(path.join(REPO, 'src'))
      .filter((f) => stripComments(readFileSync(f, 'utf-8')).includes('buzzAmountToUnitAmount'))
      .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
      .filter((rel) => rel !== 'src/shared/utils/buzz-charge.ts')
      .sort();

    // Exact set: fails when it GROWS (a second derivation site that this guard has never been
    // pointed at) as well as when it shrinks.
    expect(importers).toEqual([FORM_REL]);
  });

  it('the legacy purchase component is still dead', () => {
    // It open-codes the derivation twice. That is tolerable only while nothing imports it, so the
    // deadness is asserted rather than assumed.
    const legacy = path.posix.basename(DEAD_LEGACY_REL, '.tsx');
    const importers = walkSources(path.join(REPO, 'src'))
      .filter((f) => path.relative(REPO, f).split(path.sep).join('/') !== DEAD_LEGACY_REL)
      .filter((f) => {
        const src = stripComments(readFileSync(f, 'utf-8'));
        return new RegExp(`from\\s*'[^']*/${legacy}'`).test(src);
      });
    expect(importers).toEqual([]);
  });
});

describe('the ratio the server re-derives matches the one the client applies', () => {
  it('the server tamper guard still divides by the same ratio', () => {
    const service = stripComments(readFileSync(STRIPE_SERVICE, 'utf-8'));
    const guard = service.match(/unitAmount\s*!==\s*metadata\.buzzAmount\s*\/\s*(\d+)/);
    expect(guard, 'the getPaymentIntent amount-tamper guard should still be present').not.toBe(
      null
    );
    expect(Number(guard?.[1])).toBe(BUZZ_PER_USD_CENT);
  });

  it('the helper and the constant agree arithmetically, not just textually', () => {
    expect(buzzAmountToUnitAmount(BUZZ_PER_USD_CENT * 100)).toBe(100);
    expect(BUZZ_PER_USD_CENT).toBe(10);
  });

  it('the helper still ceils — the buyer is never granted Buzz they did not pay for', () => {
    const helper = stripComments(readFileSync(HELPER, 'utf-8'));
    expect(helper).toMatch(/Math\.ceil\(/);
    expect(helper).not.toMatch(/Math\.(round|floor|trunc)\(/);
  });
});
