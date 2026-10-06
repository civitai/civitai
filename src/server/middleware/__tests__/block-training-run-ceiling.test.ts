import { describe, expect, it } from 'vitest';
import {
  BLOCK_TRAINING_MAX_BUZZ_PER_RUN,
  blockTrainingRunCeiling,
  type BlockTrainingQuoteGrant,
} from '../block-scope.middleware';

/**
 * `blockTrainingRunCeiling` — the one ceiling allowed to exceed a token's per-call
 * budget, and only for a quote its own subject confirmed. Each case below breaks
 * exactly ONE condition of an otherwise-granting input, so a mutant that drops any
 * single condition turns exactly that case red.
 */

const CLAIMS = {
  // A per-call budget FAR below the quote — the point of the grant.
  buzzBudget: 50,
  appBlockId: 'apb_1',
  blockInstanceId: 'page_apb_1',
};
const QUOTE: BlockTrainingQuoteGrant = {
  userId: 42,
  appBlockId: 'apb_1',
  blockInstanceId: 'page_apb_1',
  total: 1234,
  consentedBy: 42,
};

describe('blockTrainingRunCeiling', () => {
  it('grants the confirmed price, above the per-call budget', () => {
    expect(blockTrainingRunCeiling(CLAIMS, QUOTE, 42)).toBe(1234);
  });

  it('caps a confirmed price at the per-run maximum', () => {
    expect(blockTrainingRunCeiling(CLAIMS, { ...QUOTE, total: 9999 }, 42)).toBe(
      BLOCK_TRAINING_MAX_BUZZ_PER_RUN
    );
    expect(BLOCK_TRAINING_MAX_BUZZ_PER_RUN).toBe(5000);
  });

  it.each([
    ['no per-call budget was minted', { ...CLAIMS, buzzBudget: undefined }, QUOTE, 42],
    [
      'an editor’s read-only private run',
      { ...CLAIMS, privateRunAudience: 'editor' as const },
      QUOTE,
      42,
    ],
    ['nobody confirmed it', CLAIMS, { ...QUOTE, consentedBy: null }, 42],
    ['another user confirmed it', CLAIMS, { ...QUOTE, consentedBy: 7 }, 42],
    ['it is another viewer’s quote', CLAIMS, { ...QUOTE, userId: 7 }, 42],
    ['it belongs to another app', CLAIMS, { ...QUOTE, appBlockId: 'apb_2' }, 42],
    ['it belongs to another install', CLAIMS, { ...QUOTE, blockInstanceId: 'page_x' }, 42],
    ['the total is not a whole number', CLAIMS, { ...QUOTE, total: 12.5 }, 42],
    ['the total is not positive', CLAIMS, { ...QUOTE, total: -5 }, 42],
  ])('is 0 when %s', (_l, claims, quote, subject) => {
    expect(blockTrainingRunCeiling(claims, quote, subject)).toBe(0);
  });
});
