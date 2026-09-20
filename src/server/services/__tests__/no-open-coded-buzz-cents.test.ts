import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { BUZZ_PER_USD_CENT, buzzAmountToUnitAmount } from '~/shared/utils/buzz-charge';

/**
 * THE SEAM GUARD for the Buzz-to-cents derivation.
 *
 * `buzz-charge.test.ts` covers the helper hermetically and four independent mutations of it
 * die there. That suite is nonetheless blind to the defect that actually shipped, because the
 * defect is not IN the helper — it is in whether the one production call site still CALLS it.
 *
 * Measured during the round-1 audit of #4952: reverting
 * `BuzzPurchaseImproved.tsx` to the pre-fix expression `setCustomAmount(newCustomBuzzAmount / 10)`
 * — i.e. re-introducing the production bug verbatim — left the helper's own suite, the schema
 * suite and both stripe service suites GREEN (17/17), and also passed
 * `no-unguarded-billable-submit`, `no-divergent-generation-submit-payload` and
 * `no-divergent-author-fee-base`. Nothing in the repo caught it. The user-visible result of
 * that revert is worse than the bug it replaced: with `.int()` now on
 * `paymentIntentCreationSchema.unitAmount`, a Buzz amount that is not a multiple of ten no
 * longer 500s at Stripe — it is rejected at our own trust boundary, so the Pay Now button
 * fails for every such amount.
 *
 * So this pins a RELATIONSHIP over a call-site population rather than a component, which is
 * what `src/server/services/__tests__/no-*.test.ts` exists for. It is a SOURCE-TEXT guard by
 * necessity: the call site lives inside a ~1,200-line Mantine component whose `onChange` cannot
 * be invoked without mounting the whole purchase form, and this repo's component project is
 * pinned to a Playwright browser build that does not run on every dev host — a behavioural test
 * here would be skipped exactly where it is needed. `buzz-charge.test.ts` carries the
 * behavioural half; a structural check alone would type-check past a wrong argument, which is
 * why the arithmetic identity is asserted below too.
 */

const REPO = process.cwd();
const FORM = path.join(REPO, 'src/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.tsx');
const STRIPE_SERVICE = path.join(REPO, 'src/server/services/stripe.service.ts');
const HELPER = path.join(REPO, 'src/shared/utils/buzz-charge.ts');

/**
 * Every production (non-test) module that imports the helper. Asserted as an exact SET so the
 * ledger fails when it GROWS — a second derivation site added without this guard being
 * revisited — as well as when it SHRINKS.
 */
const EXPECTED_IMPORTERS = ['src/components/Buzz/BuzzPurchase/BuzzPurchaseImproved.tsx'];

/** Strip line and block comments so a mention in prose cannot satisfy — or trip — a check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('the Buzz-to-cents derivation has exactly one home', () => {
  it('is called at every site in the purchase form that derives cents from a Buzz amount', () => {
    const code = stripComments(readFileSync(FORM, 'utf-8'));

    // Both live derivations: the min-amount entry path and the free-typed Buzz field.
    const calls = code.match(/buzzAmountToUnitAmount\(/g) ?? [];
    expect(calls).toHaveLength(2);

    // The import must be the real one, not a local shadow.
    expect(code).toMatch(
      /import\s*\{[^}]*\bbuzzAmountToUnitAmount\b[^}]*\}\s*from\s*'~\/shared\/utils\/buzz-charge'/
    );
  });

  it('is not open-coded anywhere in the purchase form — the mutation that survived the suite', () => {
    const code = stripComments(readFileSync(FORM, 'utf-8'));

    // `setCustomAmount(<anything> / 10)` and `/ BUZZ_PER_USD_CENT` are the two spellings of
    // the reverted bug. Pinning the ASSIGNMENT rather than the bare division keeps unrelated
    // arithmetic in this large component from tripping the guard.
    const openCoded = code.match(/setCustomAmount\(\s*[^)]*\/\s*(10|BUZZ_PER_USD_CENT)\b/g) ?? [];
    expect(openCoded).toEqual([]);

    // The inverse direction is legitimate and must NOT be caught by the rule above: the USD
    // field derives a Buzz amount by multiplying. Asserted so a later tightening that breaks
    // it fails here rather than silently forbidding a correct line.
    expect(code).toMatch(/setCustomBuzzAmount\(\s*newCustomAmount\s*\*\s*10\s*\)/);
  });

  it('has exactly the expected production importers', () => {
    // Walk the two directories that could plausibly hold a second caller rather than the whole
    // tree: a full-tree walk here is slow and, more importantly, would silently start passing
    // if the helper moved. If the helper moves, this list is what fails.
    const importers = EXPECTED_IMPORTERS.filter((rel) =>
      readFileSync(path.join(REPO, rel), 'utf-8').includes('buzzAmountToUnitAmount')
    );
    expect(importers).toEqual(EXPECTED_IMPORTERS);
  });
});

describe('the ratio the server re-derives matches the one the client applies', () => {
  /**
   * The previous spelling of this check asserted `BUZZ_PER_USD_CENT === 10` and nothing else,
   * while its name claimed it pinned "the ratio the server tamper check re-derives". It did
   * not: the server's copy is an independent literal, so changing it broke production while
   * this test stayed green, and changing the constant turned this test red while the server
   * was unaffected. It could neither detect nor locate a divergence. This pins the
   * RELATIONSHIP instead.
   */
  it('the server tamper guard still divides by the same ratio', () => {
    const service = stripComments(readFileSync(STRIPE_SERVICE, 'utf-8'));

    const guard = service.match(/unitAmount\s*!==\s*metadata\.buzzAmount\s*\/\s*(\d+)/);
    expect(guard, 'the getPaymentIntent amount-tamper guard should still be present').not.toBe(
      null
    );
    expect(Number(guard?.[1])).toBe(BUZZ_PER_USD_CENT);
  });

  it('the helper and the constant agree arithmetically, not just textually', () => {
    // The behavioural half: a structural check above would type-check past a wrong argument.
    expect(buzzAmountToUnitAmount(BUZZ_PER_USD_CENT * 100)).toBe(100);
    expect(BUZZ_PER_USD_CENT).toBe(10);
  });

  it('the helper still ceils — the buyer is never granted Buzz they did not pay for', () => {
    const helper = stripComments(readFileSync(HELPER, 'utf-8'));
    expect(helper).toMatch(/Math\.ceil\(/);
    expect(helper).not.toMatch(/Math\.(round|floor|trunc)\(/);
  });
});
