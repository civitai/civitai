import { isSafeToRetry } from '@civitai/buzz';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refundMultiTransaction, logAxiomError } = vi.hoisted(() => ({
  refundMultiTransaction: vi.fn(async () => ({})),
  logAxiomError: vi.fn(async () => undefined),
}));

vi.mock('../buzz', () => ({ getBuzz: () => ({ refundMultiTransaction }) }));
vi.mock('../axiom', () => ({ logAxiomError }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { refundAppealFee } = await import('../image-moderation-effects');

const FEE = 'appeal-7-1790000000000-abcd1234';
const refund = () => refundAppealFee({ id: 9, buzzTransactionId: FEE, entityId: 41 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refundAppealFee', () => {
  // Decision, not an accident: a timed-out refund may still have landed, so retrying it can pay the
  // fee back twice. Do not drop the predicate to restore the client's retry-everything default.
  it('retries a refund only when the request never reached Buzz', async () => {
    await refund();

    expect(refundMultiTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: FEE }),
      { shouldRetry: isSafeToRetry }
    );
  });

  it('does not resend a refund that timed out, and records the fee as owed', async () => {
    refundMultiTransaction.mockRejectedValueOnce(
      Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
    );

    await refund();

    expect(refundMultiTransaction).toHaveBeenCalledTimes(1);
    expect(logAxiomError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ appealId: 9, buzzTransactionId: FEE })
    );
  });
});
