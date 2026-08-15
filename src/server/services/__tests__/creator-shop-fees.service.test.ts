import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as LoggingClient from '~/server/logging/client';
import {
  CREATOR_SHOP_FEE_MAX,
  DEFAULT_CREATOR_SHOP_FEES,
  creatorCosmeticTypes,
} from '~/server/schema/creator-shop.schema';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
dbMock.dbWrite.keyValue.findUnique.mockImplementation((...args: unknown[]) =>
  (mocks.keyValueFindUnique as (...a: unknown[]) => unknown)(...args)
);
dbMock.dbWrite.$executeRawUnsafe.mockImplementation((...args: unknown[]) =>
  (mocks.executeRawUnsafe as (...a: unknown[]) => unknown)(...args)
);
loggingMock.logToAxiom.mockImplementation((...args: unknown[]) =>
  (mocks.logToAxiom as (...a: unknown[]) => unknown)(...args)
);

const { mocks } = vi.hoisted(() => ({
  mocks: {
    keyValueFindUnique: vi.fn(),
    executeRawUnsafe: vi.fn(),
    logToAxiom: vi.fn(),
  },
}));

const { assertQuotedFee, getCreatorShopFees, getCreatorShopSubmissionFee, setCreatorShopFees } =
  await import('../creator-shop-fees.service');

const stored = (value: unknown) => mocks.keyValueFindUnique.mockResolvedValue({ key: 'k', value });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.keyValueFindUnique.mockResolvedValue(null);
  mocks.logToAxiom.mockResolvedValue(undefined);
});

describe('getCreatorShopFees', () => {
  // The whole point of the change: one type's fee moves without repricing the rest.
  it('resolves each cosmetic type independently', async () => {
    stored({ submission: { Sticker: 5000, Badge: 12000 } });
    const fees = await getCreatorShopFees();

    expect(fees.submission.Sticker).toBe(5000);
    expect(fees.submission.Badge).toBe(12000);
    expect(fees.submission.ProfileDecoration).toBe(10000);
    expect(fees.submission.ProfileBackground).toBe(10000);
    expect(fees.submission.ContentDecoration).toBe(10000);
  });

  it('serves 10000 for every type and 1000 for packs when the row is absent', async () => {
    const fees = await getCreatorShopFees();

    expect(fees).toEqual(DEFAULT_CREATOR_SHOP_FEES);
    for (const type of creatorCosmeticTypes) expect(fees.submission[type]).toBe(10000);
    expect(fees.pack).toBe(1000);
  });

  // A fee reaches the money path before anything is reviewed, so a junk value must
  // not travel — and it must not take the sibling types down with it either.
  it('falls back per value on a malformed row', async () => {
    for (const value of [
      42,
      'ten thousand',
      { submission: 'all of them' },
      { submission: { Sticker: -1, Badge: 1.5 }, pack: Number.NaN },
      { submission: { Sticker: null }, pack: '1000' },
    ]) {
      stored(value);
      const fees = await getCreatorShopFees();
      expect(fees).toEqual(DEFAULT_CREATOR_SHOP_FEES);
    }
  });

  // A fat-fingered extra digit is the realistic version of this, and the fee is
  // taken before review and never refunded.
  it('falls back rather than serving an absurd fee', async () => {
    stored({ submission: { Sticker: 1e15 }, pack: CREATOR_SHOP_FEE_MAX + 1 });
    const fees = await getCreatorShopFees();

    expect(fees.submission.Sticker).toBe(DEFAULT_CREATOR_SHOP_FEES.submission.Sticker);
    expect(fees.pack).toBe(DEFAULT_CREATOR_SHOP_FEES.pack);
  });

  it('serves a fee sitting exactly on the ceiling', async () => {
    stored({ submission: { Sticker: CREATOR_SHOP_FEE_MAX } });
    await expect(getCreatorShopSubmissionFee(CosmeticType.Sticker)).resolves.toBe(
      CREATOR_SHOP_FEE_MAX
    );
  });

  it('keeps a usable sibling when one type is junk', async () => {
    stored({ submission: { Sticker: 5000, Badge: 'free' } });
    const fees = await getCreatorShopFees();

    expect(fees.submission.Sticker).toBe(5000);
    expect(fees.submission.Badge).toBe(10000);
  });

  // Not the placement-config posture. Quoting a default while the row says something
  // lower would charge more than the submit form showed.
  it('refuses to invent a fee when the row cannot be read', async () => {
    mocks.keyValueFindUnique.mockRejectedValue(new Error('KeyValue unavailable'));
    await expect(getCreatorShopFees()).rejects.toThrow('KeyValue unavailable');
  });
});

describe('getCreatorShopSubmissionFee', () => {
  it('returns the stored fee for the type asked for', async () => {
    stored({ submission: { Sticker: 5000 } });

    await expect(getCreatorShopSubmissionFee(CosmeticType.Sticker)).resolves.toBe(5000);
    await expect(getCreatorShopSubmissionFee(CosmeticType.Badge)).resolves.toBe(10000);
  });
});

describe('setCreatorShopFees', () => {
  it('leaves the types it was not given alone', async () => {
    stored({ submission: { Sticker: 5000, Badge: 12000 }, pack: 2000 });

    const next = await setCreatorShopFees({ submission: { Sticker: 7000 } });

    expect(next.submission.Sticker).toBe(7000);
    expect(next.submission.Badge).toBe(12000);
    expect(next.pack).toBe(2000);
    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  // This write decides how much Buzz every creator is charged before review, so
  // "who changed it from what to what" has to survive the request.
  it('records the actor and both sides of the change', async () => {
    stored({ submission: { Sticker: 5000 }, pack: 2000 });

    await setCreatorShopFees({ submission: { Sticker: 7000 } }, { actorId: 42 });

    expect(mocks.logToAxiom).toHaveBeenCalledTimes(1);
    const logged = mocks.logToAxiom.mock.calls[0][0];
    expect(logged).toMatchObject({ name: 'set-creator-shop-fees', actorId: 42 });
    expect(logged.previous.submission.Sticker).toBe(5000);
    expect(logged.next.submission.Sticker).toBe(7000);
  });

  // The row is written before the log. Rejecting here would return a 500 for a change
  // that committed, and the retry it invites records `previous` as the new value.
  it('does not fail the write when the log does', async () => {
    stored({ submission: { Sticker: 5000 }, pack: 2000 });
    mocks.logToAxiom.mockRejectedValue(new Error('axiom down'));

    const next = await setCreatorShopFees({ submission: { Sticker: 7000 } }, { actorId: 42 });

    expect(next.submission.Sticker).toBe(7000);
    expect(mocks.executeRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe('assertQuotedFee', () => {
  it('accepts the fee the form quoted', () => {
    expect(() => assertQuotedFee(5000, 5000)).not.toThrow();
  });

  // Charging the new number silently is the bug: the fee is non-refundable and
  // the creator only ever saw the old one.
  it('refuses a quote that no longer matches, naming the fee now in force', () => {
    expect(() => assertQuotedFee(10000, 5000)).toThrow(/5000/);
  });

  it('refuses a quote that is too low as well as one that is too high', () => {
    expect(() => assertQuotedFee(0, 5000)).toThrow();
  });
});
