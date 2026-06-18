import { describe, expect, it } from 'vitest';
import {
  BLOCK_PAYOUT_REFCODE_PREFIX,
  getBlockPayoutRefCode,
  isBlockPayoutRefCode,
  newBlockPayoutWithdrawalId,
} from '../app-block-ids';

describe('App-Blocks payout refCode (audit blocker #2)', () => {
  it('derives a refCode that does NOT collide with the creator-program CW prefix', () => {
    const id = newBlockPayoutWithdrawalId();
    const refCode = getBlockPayoutRefCode(id);
    expect(refCode.startsWith(BLOCK_PAYOUT_REFCODE_PREFIX)).toBe(true);
    // CRITICAL: the Tipalti webhook dispatches creator-program payouts on the
    // 'CW' prefix. Ours must never start with 'CW' or it would misroute → 400.
    expect(refCode.startsWith('CW')).toBe(false);
  });

  it('fits within Tipalti’s 16-char refCode cap', () => {
    const refCode = getBlockPayoutRefCode(newBlockPayoutWithdrawalId());
    expect(refCode.length).toBeLessThanOrEqual(16);
    // exactly 16 (BPW + 13-char ULID tail)
    expect(refCode.length).toBe(16);
  });

  it('isBlockPayoutRefCode recognizes the rail and rejects CW / buzz refCodes', () => {
    expect(isBlockPayoutRefCode(getBlockPayoutRefCode(newBlockPayoutWithdrawalId()))).toBe(true);
    expect(isBlockPayoutRefCode('CW123_abc')).toBe(false);
    expect(isBlockPayoutRefCode('someBuzzTransferId')).toBe(false);
  });

  it('two distinct withdrawal ids yield distinct refCodes', () => {
    const a = getBlockPayoutRefCode(newBlockPayoutWithdrawalId());
    const b = getBlockPayoutRefCode(newBlockPayoutWithdrawalId());
    expect(a).not.toBe(b);
  });
});
