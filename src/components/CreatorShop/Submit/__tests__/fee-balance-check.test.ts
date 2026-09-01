import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * 🔒 The submission-fee button must check the balance of the PICKED account only.
 *
 * `BuzzTransactionButton` has two props here and they are not synonyms:
 * `accountTypes` runs through `useAvailableBuzz`, which STRIPS yellow/green from
 * what it is given and appends the domain's own currency; `exactAccountTypes`
 * skips that. So `accountTypes={[buzzType]}` checks a different account than the
 * one the server bills, and the two only coincide when the pick happens to equal
 * the domain currency.
 *
 * The consequence is a blocked submit, not a wrong charge: a short balance sends
 * `conditionalPerformTransaction` to the Buy Buzz modal instead of the mutation.
 * A green-domain creator holding 5,000 yellow who picks yellow is checked against
 * their green balance, and is told to buy Buzz they already have.
 *
 * `CreatorShopPackModal` was fixed when packs shipped and carries a comment saying
 * why. `CreatorShopSubmitModal` kept the bare prop, and the pack's own guard could
 * not see it because that guard reads only the pack file. Hence this one, which
 * reads both.
 *
 * 🔴 IF YOU ARE HERE TO DELETE THIS: `exactAccountTypes` is deliberate at both call
 * sites. The fee is charged with `fromAccountType: buzzType` and nothing else
 * (`creator-shop.service.ts`, `creator-shop-pack.service.ts`), so any balance check
 * that widens past the pick is checking the wrong account. Reverting to
 * `accountTypes` because it reads more naturally restores the bug silently — the
 * button still renders, and no other test fails.
 *
 * Source-gate rather than a render: the defect is a prop NAME, which is what a
 * source read sees and what a mocked render sails past.
 */
const MODALS = [
  ['CreatorShopSubmitModal', '../../CreatorShopSubmitModal.tsx'],
  ['CreatorShopPackModal', '../../Pack/CreatorShopPackModal.tsx'],
] as const;

describe.each(MODALS)('%s fee button', (name, relativePath) => {
  const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf-8');

  it('checks the picked account alone', () => {
    expect(source).toContain('exactAccountTypes={[buzzType]}');
  });

  it('does not widen the check to the domain currency', () => {
    // Read the PREFIX rather than searching for the bare spelling: `accountTypes`
    // is a substring of `exactAccountTypes`, so a plain `not.toContain` would fail
    // against the fix itself.
    const widened = [...source.matchAll(/(\w*)accountTypes=\{\[buzzType\]\}/gi)].filter(
      (match) => match[1].toLowerCase() !== 'exact'
    );

    expect(
      widened.map((match) => match[0]),
      `${name} passes ${widened[0]?.[0]} to BuzzTransactionButton, so the fee button checks ` +
        'the domain currency instead of the account the server bills. Use exactAccountTypes.'
    ).toEqual([]);
  });
});
