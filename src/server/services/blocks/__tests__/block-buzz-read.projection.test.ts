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

  // ── Curated dashboard-classifier allowlist (type + forId) ────────────────
  // KEEP only the dashboard-relevant income/attribution types; DROP everything
  // else (moderation / referral / follow / reaction tags + any future type).

  it.each([
    ['dailyBoost', 20260714], // claim-calendar day (YYYYMMDD)
    ['imagePostedToModel', 501001], // modelVersionId
    ['firstDailyPost', 999001], // postId
    ['goodContent:image', 12345], // prefix match — reaction income (entityId)
    ['goodContent:model', 777], // prefix match
    ['collectedContent:image', 22222], // prefix match — collection income
    ['collectedContent:article', 333], // prefix match
  ])('keeps type + numeric forId for allowlisted reward type %s', (type, forId) => {
    const out = projectBlockBuzzTransaction(
      row({ type: TransactionType.Reward, details: { type, forId, byUserId: 42 } })
    );
    const details = out.details as Record<string, unknown>;
    expect(details.type).toBe(type);
    expect(details.forId).toBe(forId);
    // Who triggered the reward stays private (reactions are anonymous on-site).
    expect(details).not.toHaveProperty('byUserId');
  });

  it.each([
    ['reportAccepted', 88123], // moderation-report activity + reportId — the sharpest leak
    ['refereeCreated', 4242], // the referrer's user id — referral edge
    ['firstDailyFollow', 7777], // the followed user's id — follow edge
    ['encouragement:reaction', 5150], // the viewer's reaction footprint
    ['ad-watched', 909], // ad session (non-dashboard)
    ['userReferred', 4242], // referral edge (the mirror side)
    ['someNewRewardType', 1234], // STRUCTURAL: an unknown/future type is default-denied
  ])('drops BOTH type and forId for non-allowlisted reward type %s', (type, forId) => {
    const out = projectBlockBuzzTransaction(
      row({ type: TransactionType.Reward, details: { type, forId } })
    );
    const details = out.details as Record<string, unknown>;
    expect(details.type).toBeUndefined();
    expect(details.forId).toBeUndefined();
  });

  it('drops a STRING forId even under an allowlisted type (numeric guard belt-and-suspenders)', () => {
    const out = projectBlockBuzzTransaction(
      row({ type: TransactionType.Reward, details: { type: 'dailyBoost', forId: 'not-a-number' } })
    );
    const details = out.details as Record<string, unknown>;
    // type is allowlisted so it stays; the non-numeric subject id is still dropped.
    expect(details.type).toBe('dailyBoost');
    expect(details.forId).toBeUndefined();
  });

  it.each(['download', 'generation'])(
    'keeps the early-access sale classifiers for %s: modelVersionId + type',
    (kind) => {
      const out = projectBlockBuzzTransaction(
        row({
          type: TransactionType.Purchase,
          details: { modelVersionId: 501001, type: kind, earlyAccessPurchase: true },
        })
      );
      const details = out.details as Record<string, unknown>;
      expect(details.modelVersionId).toBe(501001);
      expect(details.type).toBe(kind);
      // The flag itself stays passthrough-dropped.
      expect(details).not.toHaveProperty('earlyAccessPurchase');
    }
  );

  it('drops a non-numeric modelVersionId', () => {
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
      row({ type: TransactionType.Reward, details: { type: { nested: 'object' }, forId: 5 } })
    );
    const details = out.details as Record<string, unknown>;
    expect(details.type).toBeUndefined();
    // A non-string type is not allowlisted, so forId drops too.
    expect(details.forId).toBeUndefined();
  });
});
