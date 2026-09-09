import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buzzTransactionLabel } from '~/components/Buzz/Dashboard/transaction-description';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { PLACEMENT_LEDGER_TEXT } from '~/shared/utils/placement';

/**
 * Pre-#4212 rows still in prod: 1,527 as of 2026-09-09. They are why the
 * dashboard allowlists descriptions rather than allowlisting `Fee`.
 */
const LEGACY_PLACEMENT_DESCRIPTIONS = [
  'Placement escrow (holdFee) for placement 76',
  'Placement escrow (holdPrincipal) for placement 76',
  'Placement 76 (toOwner)',
  'Placement 76 (feeToOwner)',
];

const LEDGER_DESCRIPTIONS = Object.values(PLACEMENT_LEDGER_TEXT).flatMap((byKind) =>
  Object.values(byKind)
);

describe('buzzTransactionLabel', () => {
  it.each(LEGACY_PLACEMENT_DESCRIPTIONS)('hides the legacy description %s', (description) => {
    expect(buzzTransactionLabel({ type: TransactionType.Fee, description })).toBe('Fee');
  });

  it.each(LEDGER_DESCRIPTIONS)('renders the placement description %s', (description) => {
    expect(buzzTransactionLabel({ type: TransactionType.Fee, description })).toBe(description);
  });

  /**
   * The case above takes its expected value from the table under test, so it
   * cannot see jargon returning to the table — the #4212 regression. This asks a
   * question the table can answer wrongly.
   */
  it.each(LEDGER_DESCRIPTIONS)('%s carries no internal leg name or placement id', (description) => {
    expect(description).not.toMatch(/placement \d+/i);
    expect(description).not.toMatch(
      /holdFee|holdPrincipal|toOwner|feeToOwner|toSeller|principalToPlacer|feeToPlacer|escrow/
    );
  });

  // Literal pins for three of the eighteen, so a copy change is a red diff
  // rather than a silently mutated case list.
  it.each([
    ['Someone placed a sticker on your image', PLACEMENT_LEDGER_TEXT.sticker.toOwner],
    ['Someone added a remix to your gallery', PLACEMENT_LEDGER_TEXT.remixGallery.toOwner],
    [
      'Remix submission fee, held while the creator decides',
      PLACEMENT_LEDGER_TEXT.remixGallery.holdFee,
    ],
  ])('renders %s verbatim', (expected, actual) => {
    expect(actual).toBe(expected);
    expect(buzzTransactionLabel({ type: TransactionType.Fee, description: actual })).toBe(expected);
  });

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

  /**
   * A tip's description is written by the tipper, so an allowlist checked on any
   * type would sell a system-voice line in someone else's ledger for the price of
   * one tip.
   */
  it.each([TransactionType.Tip, TransactionType.Refund, TransactionType.Bounty])(
    'does not render an allowlisted string carried by type %s',
    (type) => {
      expect(
        buzzTransactionLabel({ type, description: 'Someone placed a sticker on your image' })
      ).toBe(TransactionType[type]);
    }
  );

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
 * being paid.
 */
describe('declined-fee copy reads as money kept, not money charged', () => {
  it.each(['sticker', 'remixGallery'] as const)('%s', (surface) => {
    expect(PLACEMENT_LEDGER_TEXT[surface].feeToOwner).toMatch(/^Fee kept from /);
  });
});

/**
 * The helper is pure, so every test above passes against a dashboard that never
 * calls it. This is the only thing tying the fix to the surface the ticket is
 * about.
 */
describe('the dashboard renders through the helper', () => {
  const source = readFileSync(path.resolve(__dirname, '../BuzzDashboardOverview.tsx'), 'utf-8');

  it('calls buzzTransactionLabel', () => {
    expect(source).toContain('buzzTransactionLabel(transaction)');
  });

  it('renders no description of its own', () => {
    expect(source).not.toMatch(/\{transaction\.description\}|transaction\.description \?/);
  });
});
