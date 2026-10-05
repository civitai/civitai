import { isSafeToRetry } from '@civitai/buzz';
import { describe, expect, it, vi } from 'vitest';

const { refundMultiTransaction } = vi.hoisted(() => ({
  refundMultiTransaction: vi.fn(async () => ({})),
}));

vi.mock('../buzz', () => ({ getBuzz: () => ({ refundMultiTransaction }) }));
vi.mock('../db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('../clickhouse', () => ({ getClickhouse: () => ({}) }));

const { refundAppealFee } = await import('../image-moderation-effects');

describe('refundAppealFee', () => {
  // Decision, not an accident: a timed-out refund may still have landed, so retrying it can pay the
  // fee back twice. Do not drop the predicate to restore the client's retry-everything default.
  it('retries a refund only when the request never reached Buzz', async () => {
    await refundAppealFee({
      id: 9,
      buzzTransactionId: 'appeal-7-1790000000000-abcd1234',
      entityId: 41,
    });

    expect(refundMultiTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ externalTransactionIdPrefix: 'appeal-7-1790000000000-abcd1234' }),
      { shouldRetry: isSafeToRetry }
    );
  });
});
