import { describe, expect, it } from 'vitest';
import { buzzTransactionLabel } from '~/components/Buzz/Dashboard/transaction-description';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { PLACEMENT_LEDGER_TEXT } from '~/shared/utils/placement';

/**
 * Rows written before #4212, read out of prod on 2026-09-09: 1,527 of them, and
 * still reachable by scrolling back about three weeks. They are the reason the
 * dashboard allowlists descriptions instead of allowlisting `Fee`.
 */
const LEGACY_PLACEMENT_DESCRIPTIONS = [
  'Placement escrow (holdFee) for placement 76',
  'Placement escrow (holdPrincipal) for placement 76',
  'Placement 76 (toOwner)',
  'Placement 76 (feeToOwner)',
];

describe('buzzTransactionLabel', () => {
  it.each(LEGACY_PLACEMENT_DESCRIPTIONS)('hides the legacy description %s', (description) => {
    expect(buzzTransactionLabel({ type: TransactionType.Fee, description })).toBe('Fee');
  });

  it.each(Object.values(PLACEMENT_LEDGER_TEXT).flatMap((byKind) => Object.values(byKind)))(
    'renders the placement description %s',
    (description) => {
      expect(buzzTransactionLabel({ type: TransactionType.Fee, description })).toBe(description);
    }
  );

  it('renders the creator-program extraction fee', () => {
    expect(buzzTransactionLabel({ type: TransactionType.Fee, description: 'Extraction fee' })).toBe(
      'Extraction fee'
    );
  });

  it('falls back to the type name for an unrecognised fee description', () => {
    expect(
      buzzTransactionLabel({ type: TransactionType.Fee, description: 'Some fee nobody audited' })
    ).toBe('Fee');
  });

  it('still renders any description on the types that carry only user-facing copy', () => {
    expect(
      buzzTransactionLabel({ type: TransactionType.Reward, description: 'Daily challenge reward' })
    ).toBe('Daily challenge reward');
  });

  it('falls back to the type name when there is no description', () => {
    expect(buzzTransactionLabel({ type: TransactionType.Generation, description: null })).toBe(
      'Generation'
    );
  });
});

/**
 * The declined-fee legs credit the owner, so the row shows a POSITIVE amount.
 * "Fee for a sticker you declined" beside it reads as a charge to the person
 * being paid. Reworded 2026-09-09; delete this only alongside a copy decision,
 * not while tidying assertions.
 */
describe('declined-fee copy reads as money kept, not money charged', () => {
  it.each(['sticker', 'remixGallery'] as const)('%s', (surface) => {
    expect(PLACEMENT_LEDGER_TEXT[surface].feeToOwner).toMatch(/^Fee kept from /);
  });
});
