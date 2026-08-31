import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { submitCreatorShopPackSchema } from '~/server/schema/creator-shop.schema';

/**
 * 🔒 The pack submission fee is paid from an account the lister PICKS.
 *
 * `submitCreatorShopPack` charges `fromAccountType: buzzType`, and the schema
 * below has accepted green/yellow/blue since packs shipped — but the modal sent
 * a hardcoded `'yellow'`, so the other two were unreachable from the only UI
 * that submits a pack. A creator holding blue read that as "packs cost Yellow
 * Buzz", reported it as a missing option (Murf, #civitai-testers 2026-08-21),
 * and nothing on the screen said otherwise.
 *
 * Source-gate rather than a render, the idiom of `sticker-review-nav-link` next
 * door: the defect was a literal in the payload, which is exactly what a source
 * read sees and what a mocked render would sail past.
 *
 * 🔴 IF YOU ARE HERE TO DELETE THIS: the fee currency being the lister's choice
 * is deliberate, and it is parity with the single-item path
 * (`CreatorShopSubmitModal` → `FeeSection`), not an accident. Narrowing packs
 * back to one currency is a product decision — take it deliberately and delete
 * this test in the same commit, rather than restoring the literal because a
 * refactor made it convenient.
 *
 * NOT covered here, deliberately: which currency is CORRECT for a given
 * creator, and `acceptsBlueBuzz`, which is a different question — what buyers
 * may pay with, vetoed by any member whose creator opted out.
 */
const modalSource = fs.readFileSync(
  path.resolve(__dirname, '../CreatorShopPackModal.tsx'),
  'utf-8'
);

describe('the pack submission fee currency', () => {
  it('reaches the mutation as the picked value, not a hardcoded one', () => {
    const hardcoded = modalSource.match(/buzzType:\s*'(yellow|green|blue)'/);

    expect(
      hardcoded?.[1],
      `CreatorShopPackModal sends buzzType: '${hardcoded?.[1]}' to submitPack, so the fee is ` +
        'charged from that account whatever the lister picked. Pass the buzzType state instead.'
    ).toBeUndefined();

    // Anchored to the PAYLOAD, not to the file. A bare `toContain('buzzType,')`
    // is satisfied by the `useState` declaration, so deleting the field from the
    // mutation — and letting the schema's `.default('yellow')` supply it — would
    // restore the whole bug with the picker still on screen and this test green.
    expect(modalSource).toMatch(/submitPack\.mutateAsync\(\{[\s\S]*?\n\s+buzzType,/);
  });

  it('offers every currency the server would accept', () => {
    // Asked of the server's own schema rather than a hand-typed list: if it is
    // ever narrowed to yellow, this fails here instead of leaving the picker
    // offering what the server would refuse.
    const accepted = submitCreatorShopPackSchema.shape.buzzType;
    expect(accepted.safeParse('blue').success).toBe(true);
    expect(accepted.safeParse('green').success).toBe(true);

    expect(modalSource).toContain('<FeeSection');
    expect(modalSource).toContain('buzzType={buzzType}');
  });

  it('checks the balance of the picked account ALONE', () => {
    // `accountTypes` appends the domain currency (`useAvailableBuzz`), so with it
    // a blue pick passes the button's check on a yellow balance and then fails
    // the charge — the server bills `buzzType` and nothing else.
    expect(modalSource).toContain('exactAccountTypes={[buzzType]}');

    // Read the prefix rather than searching for the bare spelling: the string
    // being refused is a SUBSTRING of the one required, so a plain `not.toContain`
    // would fail against the fix itself.
    const bare = [...modalSource.matchAll(/(\w*)accountTypes=\{\[buzzType\]\}/gi)].filter(
      (match) => match[1].toLowerCase() !== 'exact'
    );
    expect(bare.map((match) => match[0])).toEqual([]);
  });

  it('warns about a short balance without disabling the way to fix it', () => {
    // 🔴 THE DECISION, so it is not quietly undone: a fee shortfall must NOT be a
    // term in `canSubmit`. Disabling the button takes the top-up path with it —
    // `BuzzTransactionButton` answers a short balance by opening the purchase
    // modal and submitting on success, and a disabled button never reaches its
    // own onClick. It was written that way once and reviewed back out.
    const canSubmitBlock = modalSource.match(/const canSubmit =[\s\S]*?;\n/)?.[0] ?? '';
    expect(canSubmitBlock).not.toMatch(/feeShortfall|canAffordFee/);

    // And the warning itself is only claimed once the fee AND the balances are
    // known — both read as zero while loading, which would state a falsehood
    // about the creator's money on first paint.
    expect(modalSource).toMatch(/feeShortfall =[\s\S]{0,200}!loadingBuzz/);
    expect(modalSource).toMatch(/feeShortfall =\s*!isEdit/);
    expect(modalSource).toContain('canAffordFee={!feeShortfall}');
  });
});
