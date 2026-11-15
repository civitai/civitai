import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The author share on an output unlock. Operator decision: it is the app's normal author share,
 * applied the same way as on the original spend: priced from the ORIGINAL generation's accrual
 * (its base and generation type), charged in Yellow, under the unlock's own idempotency anchor.
 *
 * ⚠️ The "on top of an already-accrued original fee" expectations below follow the CURRENT
 * policy (`UNLOCK_AUTHOR_FEE_POLICY = 'on-top'`), an open product question. Each is marked
 * `POLICY:` so a decision for 'none-if-accrued' flips exactly those lines.
 */

const mocks = vi.hoisted(() => ({
  quote: vi.fn(),
  charge: vi.fn(),
}));

vi.mock('~/server/services/blocks/author-fee-charge.service', () => ({
  BLOCK_AUTHOR_FEE_ESTIMATE_LABEL: 'estimate',
  quoteBlockAuthorFee: mocks.quote,
  chargeBlockAuthorFee: mocks.charge,
}));

import {
  chargeUnlockAuthorFee,
  quoteUnlockAuthorFee,
  unlockAuthorFeeAnchor,
  unlockAuthorFeeApplies,
  UNLOCK_AUTHOR_FEE_POLICY,
  type OriginalAuthorFee,
} from '~/server/services/blocks/block-output-unlock-fee.service';

const WF = '42-20261115120000000';
const ORIGINAL: OriginalAuthorFee = {
  feeBuzz: 13,
  baseGenerationBuzz: 260,
  generationType: 'video:wan',
};
const CONTEXT = {
  workflowId: WF,
  original: ORIGINAL,
  appId: 'app_live_characters',
  viewerUserId: 42,
  privateRun: false,
};

beforeEach(() => {
  mocks.quote.mockReset();
  mocks.charge.mockReset();
  mocks.quote.mockResolvedValue({ charge: true, feeBuzz: 13 });
  mocks.charge.mockResolvedValue({ charged: true, feeBuzz: 13, accrualId: 'acc_1' });
});

describe('the policy switch', () => {
  it('POLICY: the current policy charges the share on top', () => {
    expect(UNLOCK_AUTHOR_FEE_POLICY).toBe('on-top');
    expect(unlockAuthorFeeApplies(ORIGINAL)).toBe(true);
  });

  it("'none-if-accrued' charges none on an unlock whose original accrued a fee", () => {
    expect(unlockAuthorFeeApplies(ORIGINAL, 'none-if-accrued')).toBe(false);
  });

  it('no original fee (pass-through paths, private run, self-dealing, flag off): no unlock fee', () => {
    expect(unlockAuthorFeeApplies(null)).toBe(false);
    expect(unlockAuthorFeeApplies({ ...ORIGINAL, feeBuzz: 0 })).toBe(false);
  });
});

describe('quoteUnlockAuthorFee', () => {
  it('POLICY: prices from the original base and generation type, under the unlock anchor', async () => {
    expect(await quoteUnlockAuthorFee({ ...CONTEXT, disclosure: false })).toBe(13);
    expect(mocks.quote).toHaveBeenCalledWith({
      baseGenerationBuzz: 260,
      priceIsCap: false,
      generationType: 'video:wan',
      appId: 'app_live_characters',
      viewerUserId: 42,
      workflowLabel: `unlock:${WF}`,
      suppressQuoteLogs: false,
      privateRun: false,
    });
  });

  it('the host preview is counted and logged as an estimate', async () => {
    await quoteUnlockAuthorFee({ ...CONTEXT, disclosure: true });
    expect(mocks.quote).toHaveBeenCalledWith(
      expect.objectContaining({ workflowLabel: 'estimate', suppressQuoteLogs: true })
    );
  });

  it('no original fee: 0, and the fee service is never asked', async () => {
    expect(await quoteUnlockAuthorFee({ ...CONTEXT, original: null, disclosure: false })).toBe(0);
    expect(mocks.quote).not.toHaveBeenCalled();
  });

  it('a non-charging quote (self-dealing, private run, flag off) is 0', async () => {
    mocks.quote.mockResolvedValue({ charge: false, reason: 'self-dealing' });
    expect(await quoteUnlockAuthorFee({ ...CONTEXT, disclosure: false })).toBe(0);
  });
});

describe('chargeUnlockAuthorFee', () => {
  it('POLICY: charges in YELLOW under the unlock anchor, held to the reserved amount', async () => {
    expect(
      await chargeUnlockAuthorFee({
        ...CONTEXT,
        appBlockId: 'apb_live_characters',
        reservedAuthorFeeBuzz: 13,
      })
    ).toBe(13);
    expect(mocks.charge).toHaveBeenCalledWith({
      workflowId: `unlock:${WF}`,
      appId: 'app_live_characters',
      appBlockId: 'apb_live_characters',
      viewerUserId: 42,
      buzzType: 'yellow',
      baseGenerationBuzz: 260,
      priceIsCap: false,
      generationType: 'video:wan',
      reservedAuthorFeeBuzz: 13,
      privateRun: false,
    });
  });

  it('a charge that did not land returns 0', async () => {
    mocks.charge.mockResolvedValue({ charged: false, reason: 'debit-failed' });
    expect(
      await chargeUnlockAuthorFee({ ...CONTEXT, appBlockId: 'apb_1', reservedAuthorFeeBuzz: 13 })
    ).toBe(0);
  });

  it('its own anchor never collides with the original fee (keyed on the bare workflow id)', () => {
    expect(unlockAuthorFeeAnchor(WF)).not.toBe(WF);
    expect(unlockAuthorFeeAnchor(WF)).toBe(`unlock:${WF}`);
  });
});
