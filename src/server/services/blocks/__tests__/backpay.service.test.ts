import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App Blocks BACKPAY reader coverage (W3 attribution back-half, Slice 4).
 *
 * This is MONEY-COMPUTATION code — the load-bearing property is the DOUBLE-DARK
 * gate (a fail-closed Flipt flag AND a signed-off rate-card version, BOTH
 * required) plus the conservation/ceiling invariants, idempotency, the per-app
 * Sybil cap, and dryRun. The reader moves NO money; it only transitions
 * tracked → confirmed/held and stamps the share.
 *
 * Prisma + logger + the Flipt flag are mocked at the module boundary so the
 * test stays in-process and deterministic. `computeSpendShare` /
 * `computeSubscriptionShare` stay REAL (mocking the money math would defeat the
 * point) — only `ACTIVE_RATE_CARD` is overlaid with a fixed test card so the
 * percentages are stable regardless of the live card.
 */

const { mockDbRead, mockDbWrite, mockLog, mockFlag } = vi.hoisted(() => ({
  mockDbRead: {
    blockSubscriptionAttribution: { findMany: vi.fn() },
    blockSpendAttribution: { findMany: vi.fn() },
  },
  mockDbWrite: {
    blockSubscriptionAttribution: { updateMany: vi.fn() },
    blockSpendAttribution: { updateMany: vi.fn() },
  },
  mockLog: vi.fn(),
  mockFlag: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksBackpayEnabled: () => mockFlag(),
}));

// A fixed test rate card: subscription 20%, spend 10%, no internal owners. We
// keep computeSpendShare/computeSubscriptionShare REAL and only overlay
// ACTIVE_RATE_CARD so the math is deterministic. The mock exposes ACTIVE_RATE_CARD
// as a GETTER over a mutable holder so a test can swap to a 0%-rate card.
const DEFAULT_TEST_CARD = {
  version: 'test-v1',
  publisherSharePctByScope: {
    per_model_install: 0,
    publisher_all_my_models: 0,
    viewer_personal: 0,
    platform_default: 0,
    viewer_global: 0,
  },
  spendSharePct: 10,
  subscriptionSharePct: 20,
  internalAppOwnerUserIds: [] as number[],
  effectiveFrom: '2026-06-18',
};
const TEST_CARD = { ...DEFAULT_TEST_CARD };
const cardHolder = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../rate-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rate-card')>();
  return {
    ...actual,
    get ACTIVE_RATE_CARD() {
      return cardHolder.current;
    },
  };
});

import {
  backpayTrackedAttributions,
  internal,
  MAX_BACKPAY_CENTS_PER_APP_PER_RUN,
  SIGNED_OFF_RATE_CARD_VERSION,
} from '../backpay.service';

type SubRow = {
  id: string;
  grossValueCents: number;
  providerFeeCents: number;
  appBlockId: string;
  appOwnerUserId: number;
};
type SpendRow = {
  id: string;
  grossValueCents: number;
  appBlockId: string;
  appOwnerUserId: number;
};

function subRow(over: Partial<SubRow> = {}): SubRow {
  return {
    id: 'bsu_1',
    grossValueCents: 1000,
    providerFeeCents: 100,
    appBlockId: 'apb_1',
    appOwnerUserId: 42,
    ...over,
  };
}
function spendRow(over: Partial<SpendRow> = {}): SpendRow {
  return {
    id: 'bsa_1',
    grossValueCents: 1000,
    appBlockId: 'apb_1',
    appOwnerUserId: 42,
    ...over,
  };
}

/** Force the signed-off-version gate open to the test card's version. */
function signOff(version: string | null = TEST_CARD.version) {
  vi.spyOn(internal, 'getSignedOffRateCardVersion').mockReturnValue(version);
}

beforeEach(() => {
  vi.restoreAllMocks();
  cardHolder.current = TEST_CARD; // reset to the default 20%/10% card
  mockLog.mockReset();
  mockFlag.mockReset();
  mockDbRead.blockSubscriptionAttribution.findMany.mockReset().mockResolvedValue([]);
  mockDbRead.blockSpendAttribution.findMany.mockReset().mockResolvedValue([]);
  mockDbWrite.blockSubscriptionAttribution.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockDbWrite.blockSpendAttribution.updateMany.mockReset().mockResolvedValue({ count: 1 });
  // Default: flag ON (gate half 1 open) — individual tests override.
  mockFlag.mockResolvedValue(true);
});

describe('production default — both gate halves dark', () => {
  it('SIGNED_OFF_RATE_CARD_VERSION is null in production (no rate signed off)', () => {
    expect(SIGNED_OFF_RATE_CARD_VERSION).toBeNull();
  });
});

describe('DOUBLE-DARK gate', () => {
  it('flag off → no writes, skipped=flag-disabled', async () => {
    mockFlag.mockResolvedValue(false);
    signOff(); // even with a signed-off version, the flag half refuses

    const out = await backpayTrackedAttributions();

    expect(out.enabled).toBe(false);
    expect(out.skipped).toBe('flag-disabled');
    expect(mockDbRead.blockSubscriptionAttribution.findMany).not.toHaveBeenCalled();
    expect(mockDbRead.blockSpendAttribution.findMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockSpendAttribution.updateMany).not.toHaveBeenCalled();
  });

  it('flag on but signed-off version null → no writes, skipped=no-signed-off-rate', async () => {
    mockFlag.mockResolvedValue(true);
    signOff(null); // production default

    const out = await backpayTrackedAttributions();

    expect(out.enabled).toBe(false);
    expect(out.skipped).toBe('no-signed-off-rate');
    expect(mockDbRead.blockSubscriptionAttribution.findMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockSpendAttribution.updateMany).not.toHaveBeenCalled();
  });

  it('signed-off version set but != ACTIVE_RATE_CARD.version → refuse', async () => {
    mockFlag.mockResolvedValue(true);
    signOff('some-other-version');

    const out = await backpayTrackedAttributions();

    expect(out.enabled).toBe(false);
    expect(out.skipped).toBe('signed-off-version-mismatch');
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockSpendAttribution.updateMany).not.toHaveBeenCalled();
  });
});

describe('happy path (gate forced open)', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    signOff();
  });

  it('subscription tracked → confirmed; conservation fee+platform+author=gross exact; version stamped', async () => {
    // gross 1000, fee 100 → net 900, author = floor(900 * 20%) = 180,
    // platform = 900 - 180 = 720. fee(100)+platform(720)+author(180)=1000.
    mockDbRead.blockSubscriptionAttribution.findMany.mockResolvedValue([
      subRow({ id: 'bsu_x', grossValueCents: 1000, providerFeeCents: 100, appOwnerUserId: 7 }),
    ]);

    const out = await backpayTrackedAttributions();

    expect(out.enabled).toBe(true);
    expect(out.skipped).toBeUndefined();
    expect(out.confirmedCount).toBe(1);
    expect(out.confirmedShareCents).toBe(180);
    expect(out.heldCount).toBe(0);

    const call = mockDbWrite.blockSubscriptionAttribution.updateMany.mock.calls[0][0];
    // idempotent write gate
    expect(call.where).toEqual({ id: 'bsu_x', status: 'tracked' });
    expect(call.data.status).toBe('confirmed');
    expect(call.data.rateCardVersion).toBe(TEST_CARD.version);
    expect(call.data.appOwnerShareCents).toBe(180);
    expect(call.data.providerFeeCents).toBe(100);
    expect(call.data.platformShareCents).toBe(720);
    expect(call.data.subscriptionSharePct).toBe(20);
    expect(call.data.confirmedAt).toBeInstanceOf(Date);
    // conservation, asserted exactly
    expect(
      call.data.providerFeeCents + call.data.platformShareCents + call.data.appOwnerShareCents
    ).toBe(1000);
  });

  it('spend tracked → confirmed with share<=gross; version + pct stamped', async () => {
    // gross 1000, spend 10% → author = 100, <= gross.
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([
      spendRow({ id: 'bsa_x', grossValueCents: 1000, appOwnerUserId: 7 }),
    ]);

    const out = await backpayTrackedAttributions();

    expect(out.confirmedCount).toBe(1);
    expect(out.confirmedShareCents).toBe(100);

    const call = mockDbWrite.blockSpendAttribution.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'bsa_x', status: 'tracked' });
    expect(call.data.status).toBe('confirmed');
    expect(call.data.rateCardVersion).toBe(TEST_CARD.version);
    expect(call.data.spendSharePct).toBe(10);
    expect(call.data.appOwnerShareCents).toBe(100);
    expect(call.data.appOwnerShareCents).toBeLessThanOrEqual(1000);
    expect(call.data.confirmedAt).toBeInstanceOf(Date);
  });
});

describe('idempotency', () => {
  it('only ever reads status=tracked rows and updates WHERE status=tracked', async () => {
    mockFlag.mockResolvedValue(true);
    signOff();
    mockDbRead.blockSubscriptionAttribution.findMany.mockResolvedValue([subRow({ id: 'bsu_i' })]);
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([spendRow({ id: 'bsa_i' })]);

    await backpayTrackedAttributions();

    expect(mockDbRead.blockSubscriptionAttribution.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'tracked',
      entryType: 'charge',
    });
    expect(mockDbRead.blockSpendAttribution.findMany.mock.calls[0][0].where).toMatchObject({
      status: 'tracked',
    });
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany.mock.calls[0][0].where.status).toBe(
      'tracked'
    );
    expect(mockDbWrite.blockSpendAttribution.updateMany.mock.calls[0][0].where.status).toBe(
      'tracked'
    );
  });

  it('a second run with no tracked rows is a no-op (already-confirmed untouched)', async () => {
    mockFlag.mockResolvedValue(true);
    signOff();
    // No tracked rows left (the first run confirmed them).
    mockDbRead.blockSubscriptionAttribution.findMany.mockResolvedValue([]);
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([]);

    const out = await backpayTrackedAttributions();

    expect(out.confirmedCount).toBe(0);
    expect(out.heldCount).toBe(0);
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockSpendAttribution.updateMany).not.toHaveBeenCalled();
  });
});

describe('voided rows are never processed', () => {
  it('the read filter excludes voided rows (only status=tracked is fetched)', async () => {
    mockFlag.mockResolvedValue(true);
    signOff();
    await backpayTrackedAttributions();
    // The where clause is the guarantee voided rows never enter the set.
    expect(mockDbRead.blockSubscriptionAttribution.findMany.mock.calls[0][0].where.status).toBe(
      'tracked'
    );
    expect(mockDbRead.blockSpendAttribution.findMany.mock.calls[0][0].where.status).toBe('tracked');
  });
});

describe('Sybil per-app cap', () => {
  beforeEach(() => {
    mockFlag.mockResolvedValue(true);
    signOff();
  });

  it('rows beyond MAX_BACKPAY_CENTS_PER_APP_PER_RUN for one app → held, not confirmed', async () => {
    // Spend share is 10% of gross. To cross the 100_00-cent cap fast, use a
    // gross of 60_000 cents → share 6_000 per row. Three rows = 18_000 share;
    // cap = 10_000. Row1 (6_000) confirms (total 6_000). Row2 would push to
    // 12_000 > 10_000 → held. Row3 also held.
    const gross = 60_000;
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([
      spendRow({ id: 'bsa_1', grossValueCents: gross, appBlockId: 'apb_cap', appOwnerUserId: 7 }),
      spendRow({ id: 'bsa_2', grossValueCents: gross, appBlockId: 'apb_cap', appOwnerUserId: 7 }),
      spendRow({ id: 'bsa_3', grossValueCents: gross, appBlockId: 'apb_cap', appOwnerUserId: 7 }),
    ]);

    const out = await backpayTrackedAttributions();

    // sanity: a single row's share is under the cap so the first confirms
    expect(60_000 * 0.1).toBeLessThanOrEqual(MAX_BACKPAY_CENTS_PER_APP_PER_RUN);
    expect(out.confirmedCount).toBe(1);
    expect(out.confirmedShareCents).toBe(6_000);
    expect(out.heldCount).toBe(2);
    expect(out.cappedApps).toHaveLength(1);
    expect(out.cappedApps[0]).toMatchObject({ appBlockId: 'apb_cap', heldCount: 2 });

    const calls = mockDbWrite.blockSpendAttribution.updateMany.mock.calls.map((c) => c[0]);
    const confirmCalls = calls.filter((c) => c.data.status === 'confirmed');
    const heldCalls = calls.filter((c) => c.data.status === 'held');
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0].where.id).toBe('bsa_1');
    expect(heldCalls).toHaveLength(2);
    expect(heldCalls.every((c) => c.data.voidedReason === 'manual_review')).toBe(true);
    expect(heldCalls.every((c) => c.where.status === 'tracked')).toBe(true);
  });

  it('the cap is per app_block_id — a different app is unaffected', async () => {
    const gross = 60_000;
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([
      spendRow({ id: 'a1', grossValueCents: gross, appBlockId: 'apb_A', appOwnerUserId: 7 }),
      spendRow({ id: 'a2', grossValueCents: gross, appBlockId: 'apb_A', appOwnerUserId: 7 }),
      spendRow({ id: 'b1', grossValueCents: gross, appBlockId: 'apb_B', appOwnerUserId: 7 }),
    ]);

    const out = await backpayTrackedAttributions();

    // apb_A: row1 confirm, row2 held. apb_B: row1 confirm.
    expect(out.confirmedCount).toBe(2);
    expect(out.heldCount).toBe(1);
    expect(out.cappedApps.map((c) => c.appBlockId)).toEqual(['apb_A']);
  });
});

describe('dryRun', () => {
  it('computes the summary but writes nothing', async () => {
    mockFlag.mockResolvedValue(true);
    signOff();
    mockDbRead.blockSubscriptionAttribution.findMany.mockResolvedValue([
      subRow({ id: 'bsu_d', grossValueCents: 1000, providerFeeCents: 100, appOwnerUserId: 7 }),
    ]);
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([
      spendRow({ id: 'bsa_d', grossValueCents: 1000, appOwnerUserId: 7 }),
    ]);

    const out = await backpayTrackedAttributions({ dryRun: true });

    expect(out.enabled).toBe(true);
    expect(out.dryRun).toBe(true);
    // would confirm both: sub author 180 + spend author 100 = 280
    expect(out.confirmedCount).toBe(2);
    expect(out.confirmedShareCents).toBe(280);
    expect(mockDbWrite.blockSubscriptionAttribution.updateMany).not.toHaveBeenCalled();
    expect(mockDbWrite.blockSpendAttribution.updateMany).not.toHaveBeenCalled();
  });
});

describe('0%-rate signed-off card (edge)', () => {
  it('author share 0 still transitions tracked → confirmed, conservation holds', async () => {
    // Overlay a 0% card and sign it off.
    cardHolder.current = { ...TEST_CARD, version: 'zero-v', spendSharePct: 0, subscriptionSharePct: 0 };
    mockFlag.mockResolvedValue(true);
    signOff('zero-v');

    mockDbRead.blockSubscriptionAttribution.findMany.mockResolvedValue([
      subRow({ id: 'bsu_z', grossValueCents: 1000, providerFeeCents: 100, appOwnerUserId: 7 }),
    ]);
    mockDbRead.blockSpendAttribution.findMany.mockResolvedValue([
      spendRow({ id: 'bsa_z', grossValueCents: 1000, appOwnerUserId: 7 }),
    ]);

    const out = await backpayTrackedAttributions();

    expect(out.confirmedCount).toBe(2);
    expect(out.confirmedShareCents).toBe(0); // 0% → no author share
    expect(out.heldCount).toBe(0);

    const subCall = mockDbWrite.blockSubscriptionAttribution.updateMany.mock.calls[0][0];
    expect(subCall.data.status).toBe('confirmed');
    expect(subCall.data.appOwnerShareCents).toBe(0);
    // conservation: fee 100 + platform 900 + author 0 = gross 1000
    expect(
      subCall.data.providerFeeCents +
        subCall.data.platformShareCents +
        subCall.data.appOwnerShareCents
    ).toBe(1000);

    const spendCall = mockDbWrite.blockSpendAttribution.updateMany.mock.calls[0][0];
    expect(spendCall.data.status).toBe('confirmed');
    expect(spendCall.data.appOwnerShareCents).toBe(0);
  });
});
