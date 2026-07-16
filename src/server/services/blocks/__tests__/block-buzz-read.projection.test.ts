import { describe, it, expect } from 'vitest';
import { TransactionType } from '~/shared/constants/buzz.constants';
import {
  projectBlockBuzzTransaction,
  projectExternalTransactionId,
} from '~/server/services/blocks/block-buzz-read.projection';

/**
 * Pure-projection coverage for the buzz self-read bridge — the security
 * hardening carried over from #3132/#3140 (details allowlist + the
 * externalTransactionId leak-class fix + counterparty projection). Runs without
 * the block-router import chain so it is verifiable in isolation.
 */

// Minimal hydrated-row factory (the shape getUserBuzzTransactions returns).
function row(over: Record<string, unknown> = {}) {
  return {
    date: new Date('2026-07-01T12:00:00Z'),
    type: TransactionType.Tip,
    fromAccountId: 7,
    toAccountId: 42,
    fromAccountType: 'yellow',
    toAccountType: 'yellow',
    amount: 100,
    description: 'Tip: nice model',
    details: { entityId: 5, entityType: 'Model' },
    externalTransactionId: 'ext-1',
    fromUser: { id: 7, username: 'tipper', status: 'active' },
    toUser: { id: 42, username: 'me', status: 'active' },
    ...over,
  } as never;
}

describe('projectExternalTransactionId', () => {
  it('nulls every money-movement / external-financial type', () => {
    for (const type of [
      TransactionType.Purchase,
      TransactionType.Refund,
      TransactionType.ChargeBack,
      TransactionType.Withdrawal,
    ]) {
      expect(projectExternalTransactionId(type, 'processor-ref-xyz'), TransactionType[type]).toBeNull();
    }
  });

  it('nulls a merch Shopify ref even under type Reward (cross-type value guard)', () => {
    expect(projectExternalTransactionId(TransactionType.Reward, 'merchPurchase:SHOP-9981')).toBeNull();
  });

  it('keeps civitai-internal classifiers on non-money-movement types', () => {
    expect(
      projectExternalTransactionId(TransactionType.Reward, 'challenge-winner-prize-2026-07-place-1')
    ).toBe('challenge-winner-prize-2026-07-place-1');
    expect(projectExternalTransactionId(TransactionType.Reward, 'referral-reward:1234')).toBe(
      'referral-reward:1234'
    );
    expect(projectExternalTransactionId(TransactionType.Bounty, 'bounty-award-88-yellow')).toBe(
      'bounty-award-88-yellow'
    );
    expect(projectExternalTransactionId(TransactionType.Tip, 'ext-1')).toBe('ext-1');
  });

  it('normalizes undefined to null', () => {
    expect(projectExternalTransactionId(TransactionType.Tip, undefined)).toBeNull();
  });
});

describe('projectBlockBuzzTransaction', () => {
  it('serializes type to its name and strips counterparties to {id, username}', () => {
    const out = projectBlockBuzzTransaction(row());
    expect(out.type).toBe('Tip');
    expect(out.fromUser).toEqual({ id: 7, username: 'tipper' });
    expect(out.toUser).toEqual({ id: 42, username: 'me' });
    // The extra getUsers field never reaches the block.
    expect(out.fromUser).not.toHaveProperty('status');
  });

  it('allowlists details — DROPS stripePaymentIntentId + any passthrough, keeps attribution', () => {
    const out = projectBlockBuzzTransaction(
      row({
        type: TransactionType.Purchase,
        details: {
          user: 'buyer',
          entityId: 5,
          entityType: 'Model',
          url: '/models/5',
          toAccountType: 'yellow',
          stripePaymentIntentId: 'pi_secret_123',
          someOtherPassthrough: 'leak',
        },
      })
    );
    const details = out.details as Record<string, unknown>;
    expect(details).not.toHaveProperty('stripePaymentIntentId');
    expect(details).not.toHaveProperty('someOtherPassthrough');
    expect(details).toMatchObject({
      user: 'buyer',
      entityId: 5,
      entityType: 'Model',
      url: '/models/5',
      toAccountType: 'yellow',
    });
  });

  it('nulls externalTransactionId on a Purchase row (processor ref), keeps it on a Reward classifier', () => {
    expect(
      projectBlockBuzzTransaction(row({ type: TransactionType.Purchase, externalTransactionId: 'pi_x' }))
        .externalTransactionId
    ).toBeNull();
    expect(
      projectBlockBuzzTransaction(
        row({ type: TransactionType.Reward, externalTransactionId: 'challenge-winner-prize-1' })
      ).externalTransactionId
    ).toBe('challenge-winner-prize-1');
  });

  it('passes a null details through unchanged', () => {
    expect(projectBlockBuzzTransaction(row({ details: null })).details).toBeNull();
  });

  it('keeps the reward classifier keys: details.type + numeric forId', () => {
    const out = projectBlockBuzzTransaction(
      row({
        type: TransactionType.Reward,
        details: { type: 'dailyBoost', forId: 20260714, byUserId: 42 },
      })
    );
    const details = out.details as Record<string, unknown>;
    expect(details.type).toBe('dailyBoost');
    expect(details.forId).toBe(20260714);
    // Who triggered the reward stays private (reactions are anonymous on-site).
    expect(details).not.toHaveProperty('byUserId');
  });

  it('drops a STRING forId — the adWatched ad-session token leak guard', () => {
    const out = projectBlockBuzzTransaction(
      row({
        type: TransactionType.Reward,
        details: { type: 'adWatched', forId: 'ad-session-token-abc123' },
      })
    );
    const details = out.details as Record<string, unknown>;
    expect(details.type).toBe('adWatched');
    expect(details.forId).toBeUndefined();
  });

  it('keeps the early-access sale classifiers: modelVersionId + type', () => {
    const out = projectBlockBuzzTransaction(
      row({
        type: TransactionType.Purchase,
        details: { modelVersionId: 501001, type: 'generation', earlyAccessPurchase: true },
      })
    );
    const details = out.details as Record<string, unknown>;
    expect(details.modelVersionId).toBe(501001);
    expect(details.type).toBe('generation');
    // The flag itself stays passthrough-dropped; a non-numeric value never leaks.
    expect(details).not.toHaveProperty('earlyAccessPurchase');
    expect(
      (
        projectBlockBuzzTransaction(
          row({ details: { modelVersionId: 'not-a-number' } })
        ).details as Record<string, unknown>
      ).modelVersionId
    ).toBeUndefined();
  });

  it('drops a non-string details.type (never widens beyond internal tags)', () => {
    const out = projectBlockBuzzTransaction(
      row({ details: { type: { nested: 'object' } } })
    );
    expect((out.details as Record<string, unknown>).type).toBeUndefined();
  });
});
