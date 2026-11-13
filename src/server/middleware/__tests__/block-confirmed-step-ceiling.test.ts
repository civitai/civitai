import { describe, expect, it } from 'vitest';
import {
  BLOCK_CONFIRMED_STEP_MAX_BUZZ_PER_JOB,
  BLOCK_TRAINING_MAX_BUZZ_PER_RUN,
  blockConfirmedStepCeiling,
  blockQuoteGrantRefusal,
  type BlockQuoteGrant,
} from '../block-scope.middleware';
import { BUZZ_BUDGET_CAP } from '~/shared/constants/block-scope.constants';

/**
 * `blockConfirmedStepCeiling` — the per-job ceiling a CONFIRMED pass-through step is
 * charged against in place of the token's per-call budget. Each refusal case breaks
 * exactly ONE condition of an otherwise-granting input and asserts that condition's
 * OWN reason, so a mutant dropping any single check turns exactly that case red with
 * a different (or no) reason — never green for the wrong reason.
 */

const CLAIMS = {
  // A per-call budget FAR below the quote — the point of the grant.
  buzzBudget: 1000,
  appBlockId: 'apb_1',
  blockInstanceId: 'page_apb_1',
};
// 1040 — the motivating 3D price, above this token's per-call budget.
const QUOTE: BlockQuoteGrant = {
  userId: 42,
  appBlockId: 'apb_1',
  blockInstanceId: 'page_apb_1',
  total: 1040,
  consentedBy: 42,
};

describe('blockConfirmedStepCeiling', () => {
  it('grants the confirmed price, above the per-call budget', () => {
    expect(blockConfirmedStepCeiling(CLAIMS, QUOTE, 42)).toEqual({ ceiling: 1040 });
  });

  it('grants exactly the per-job maximum, and the maximum is its own constant at 5000', () => {
    expect(
      blockConfirmedStepCeiling(
        CLAIMS,
        { ...QUOTE, total: BLOCK_CONFIRMED_STEP_MAX_BUZZ_PER_JOB },
        42
      )
    ).toEqual({ ceiling: 5000 });
    expect(BLOCK_CONFIRMED_STEP_MAX_BUZZ_PER_JOB).toBe(5000);
    expect(BLOCK_TRAINING_MAX_BUZZ_PER_RUN).toBe(5000);
  });

  // Equal, so a token at the per-call cap has no price that is both above its budget
  // and within this maximum. Raising either one alone changes who is offered a confirm.
  it('the per-call budget cap equals the per-job maximum', () => {
    expect(BUZZ_BUDGET_CAP).toBe(BLOCK_CONFIRMED_STEP_MAX_BUZZ_PER_JOB);
  });

  it.each([
    ['no per-call budget was minted', { ...CLAIMS, buzzBudget: undefined }, QUOTE, 'no-budget'],
    ['a zero per-call budget', { ...CLAIMS, buzzBudget: 0 }, QUOTE, 'no-budget'],
    [
      'an editor’s read-only private run',
      { ...CLAIMS, privateRunAudience: 'editor' as const },
      QUOTE,
      'no-budget',
    ],
    ['it is another viewer’s quote', CLAIMS, { ...QUOTE, userId: 7, consentedBy: 7 }, 'not-bound'],
    ['it belongs to another app', CLAIMS, { ...QUOTE, appBlockId: 'apb_2' }, 'not-bound'],
    ['it belongs to another install', CLAIMS, { ...QUOTE, blockInstanceId: 'page_x' }, 'not-bound'],
    ['nobody confirmed it', CLAIMS, { ...QUOTE, consentedBy: null }, 'not-confirmed'],
    ['another user confirmed it', CLAIMS, { ...QUOTE, consentedBy: 7 }, 'not-confirmed'],
    ['the total is not a whole number', CLAIMS, { ...QUOTE, total: 1040.5 }, 'invalid-total'],
    ['the total is zero', CLAIMS, { ...QUOTE, total: 0 }, 'invalid-total'],
    ['the total is negative', CLAIMS, { ...QUOTE, total: -5 }, 'invalid-total'],
    ['the total is NaN', CLAIMS, { ...QUOTE, total: Number.NaN }, 'invalid-total'],
    ['the total is above the per-job maximum', CLAIMS, { ...QUOTE, total: 5001 }, 'above-max'],
  ])('refuses when %s — with its own reason', (_l, claims, quote, reason) => {
    expect(blockConfirmedStepCeiling(claims, quote, 42)).toEqual({ refusal: reason });
  });

  it('the shared grant check is what both ceilings consult (same answer for training)', () => {
    // The training ceiling collapses every refusal to 0; the shared check is the one
    // place the reasons live, so a grant refused here is refused for both.
    expect(blockQuoteGrantRefusal(CLAIMS, QUOTE, 42)).toBeNull();
    expect(blockQuoteGrantRefusal(CLAIMS, { ...QUOTE, consentedBy: null }, 42)).toBe(
      'not-confirmed'
    );
  });
});
