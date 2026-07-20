import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W3 flow A — buzz SPEND attribution service coverage. TRACK-ONLY (mirrors
 * #2629's membership rework): the write records the EVENT + the money BASIS
 * (gross USD value of the Buzz burned) only — NO rate card is applied at write
 * time. The author bounty is deferred to a payout-time backpay over
 * status='tracked' rows. The interesting surface is:
 *   - track-only row shape: status='tracked', author_share=0,
 *     spend_share_pct=0, rate_card_version='unrated', gross recorded
 *   - the write NEVER calls computeSpendShare (the share is deferred)
 *   - self-spend wash (spender == app owner → voided + 0 share)
 *   - internal-owner wash (app owner ∈ internalAppOwnerUserIds → voided)
 *   - idempotency via the (workflow_id, app_block_id) UNIQUE (P2002)
 *   - missing-app guard
 *   - the platform-funded-bounty ledger invariant (0 ≤ share ≤ gross)
 *
 * Prisma + logger are mocked at the module boundary so the test stays
 * in-process and deterministic. The Prom counter is real (the service
 * wraps it in try/catch) — no need to mock it.
 */

class FakePrismaKnownError extends Error {
  code: string;
  clientVersion: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.clientVersion = 'test';
  }
}

const { mockDbRead, mockDbWrite, mockLog, mockAppsQuery, mockRequireAppsDb } = vi.hoisted(() => ({
  mockDbRead: {
    oauthClient: { findUnique: vi.fn() },
    blockSpendAttribution: { findUnique: vi.fn() },
    // G5 content-author resolution reads AppBlock.blockId to derive the app's
    // shared-storage schema slug (server-side, from the appBlockId).
    appBlock: { findUnique: vi.fn() },
  },
  mockDbWrite: {
    blockSpendAttribution: { create: vi.fn() },
  },
  mockLog: vi.fn(),
  // G5: the app-shared datastore pool (`app_<slug>.shared_kv` lookup).
  mockAppsQuery: vi.fn(),
  mockRequireAppsDb: vi.fn(),
}));

vi.mock('~/server/db/client', () => ({
  dbRead: mockDbRead,
  dbWrite: mockDbWrite,
}));
// G5: mock the app-shared datastore. `apps-slug` (sanitizeAppSlug/appSchemaIdent)
// runs REAL — it's a pure, deterministic string helper.
vi.mock('~/server/db/appsDb', () => ({
  requireAppsDb: (...args: unknown[]) => mockRequireAppsDb(...args),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => {
    mockLog(...args);
    return Promise.resolve(null);
  },
}));

// Spy on computeSpendShare so the track-only contract is testable: the write
// must NEVER call it (the bounty is deferred to payout). Everything else from
// rate-card stays real.
const computeSpendShareSpy = vi.hoisted(() => vi.fn());
vi.mock('../rate-card', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../rate-card')>();
  return {
    ...actual,
    computeSpendShare: (...args: Parameters<typeof actual.computeSpendShare>) => {
      computeSpendShareSpy(...args);
      return actual.computeSpendShare(...args);
    },
  };
});

// Spy on the per-APP bounty cap. `recordSpendAttribution` dynamic-imports it to
// reserve/clamp the row's accrued share. The cap has its own dedicated unit
// suite (app-bounty-cap.service.test.ts) exercising Redis; here we only assert
// the WIRING: the write reserves the share it is about to accrue, and applies
// the granted amount. The default fake grants exactly what is requested (no
// clamp) so the dormant 0→0 path is faithful.
const { reserveAppBountySpy, refundAppBountySpy } = vi.hoisted(() => ({
  reserveAppBountySpy: vi.fn(),
  refundAppBountySpy: vi.fn(),
}));
vi.mock('../app-bounty-cap.service', () => ({
  reserveAppBountyAccrual: (appBlockId: string, shareCents: number) => {
    reserveAppBountySpy(appBlockId, shareCents);
    // Faithful default: grant exactly the requested share (no clamp). The
    // clamp behaviour itself is covered in the cap's own suite.
    return Promise.resolve({
      grantedCents: Math.max(0, Math.floor(shareCents)),
      clamped: false,
      total: Math.max(0, Math.floor(shareCents)),
      key: `system:blocks:bounty-cap:${appBlockId}:test`,
    });
  },
  refundAppBountyAccrual: (...args: unknown[]) => {
    refundAppBountySpy(...args);
    return Promise.resolve();
  },
}));

import {
  AttributionAppMissingError,
  buzzSpendToUsdCents,
  recordSpendAttribution,
  UNRATED_RATE_CARD_VERSION,
  type RecordSpendAttributionInput,
} from '../buzz-attribution.service';
import { ACTIVE_RATE_CARD } from '../rate-card';

const APP_ID = 'app_test';
const APP_BLOCK_ID = 'apb_test';
const APP_OWNER_USER_ID = 999;
const SPENDER_ID = 100;
const WORKFLOW_ID = 'wf_abc123';

function fakeInput(over: Partial<RecordSpendAttributionInput> = {}): RecordSpendAttributionInput {
  return {
    userId: SPENDER_ID,
    buzzAmount: 5000, // 5000 Buzz = $5 = 500 cents
    workflowId: WORKFLOW_ID,
    appId: APP_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: 'bki_test123',
    modelId: 555,
    ...over,
  };
}

// Echo the data back as the "created" row so assertions can read what the
// service computed (mirrors the real Prisma create return shape, narrowed
// to the service's `select`).
function createEchoesData() {
  mockDbWrite.blockSpendAttribution.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: data.id,
      status: data.status,
      appOwnerShareCents: data.appOwnerShareCents,
      spendSharePct: data.spendSharePct,
      grossValueCents: data.grossValueCents,
      rateCardVersion: data.rateCardVersion,
      voidedReason: data.voidedReason ?? null,
    })
  );
}

beforeEach(() => {
  mockDbRead.oauthClient.findUnique.mockReset();
  mockDbRead.blockSpendAttribution.findUnique.mockReset();
  mockDbRead.appBlock.findUnique.mockReset();
  mockDbWrite.blockSpendAttribution.create.mockReset();
  mockLog.mockReset();
  computeSpendShareSpy.mockReset();
  reserveAppBountySpy.mockReset();
  refundAppBountySpy.mockReset();
  mockAppsQuery.mockReset();
  mockRequireAppsDb.mockReset();
  // Default: app exists, owned by a different user than the spender.
  mockDbRead.oauthClient.findUnique.mockResolvedValue({
    id: APP_ID,
    userId: APP_OWNER_USER_ID,
  });
  // G5 defaults: the AppBlock resolves to a valid slug; the shared datastore is
  // available but returns NO row (so an unset key path is a clean no-author).
  mockDbRead.appBlock.findUnique.mockResolvedValue({ blockId: 'blk_test' });
  mockRequireAppsDb.mockReturnValue({ query: mockAppsQuery });
  mockAppsQuery.mockResolvedValue({ rows: [] });
  createEchoesData();
});

// G5 shared_kv author fixtures.
const CONTENT_KEY = 'k_content_01ABC';
const CONTENT_AUTHOR_ID = 777; // distinct from spender + app owner

describe('buzzSpendToUsdCents', () => {
  it('converts Buzz to USD cents at the 1000:1 ratio, floored', () => {
    expect(buzzSpendToUsdCents(1000)).toBe(100); // $1
    expect(buzzSpendToUsdCents(5000)).toBe(500); // $5
    expect(buzzSpendToUsdCents(4999)).toBe(499); // floors, never over-states
    expect(buzzSpendToUsdCents(10)).toBe(1); // 1 cent
    expect(buzzSpendToUsdCents(9)).toBe(0); // sub-cent floors to 0
    expect(buzzSpendToUsdCents(-100)).toBe(0); // garbage clamps to 0
  });
});

describe('recordSpendAttribution', () => {
  it('TRACK-ONLY: writes exactly one tracked row — event + gross, author=0, NO rate stamped', async () => {
    const res = await recordSpendAttribution(fakeInput());

    // Exactly one write.
    expect(mockDbWrite.blockSpendAttribution.create).toHaveBeenCalledTimes(1);
    expect(res.written).toBe(true);

    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];

    // Author is the appBlock's owning OauthClient user (server-derived).
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    // MONEY BASIS recorded: gross = USD value of the Buzz burned (5000 -> 500).
    expect(data.grossValueCents).toBe(500);
    // NO rate applied at write: author share 0, pct 0, version 'unrated'.
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
    expect(data.rateCardVersion).toBe(UNRATED_RATE_CARD_VERSION);
    expect(data.rateCardVersion).not.toBe(ACTIVE_RATE_CARD.version);
    // The write must NOT consult the spend rate card — the bounty is deferred.
    expect(computeSpendShareSpy).not.toHaveBeenCalled();
    // Not self/internal → tracked (share-pending), not voided.
    expect(data.status).toBe('tracked');
    expect(data.voidedReason).toBeNull();
    // Server-derived context preserved.
    expect(data.appId).toBe(APP_ID);
    expect(data.appBlockId).toBe(APP_BLOCK_ID);
    expect(data.workflowId).toBe(WORKFLOW_ID);
    expect(data.userId).toBe(SPENDER_ID);
    expect(res.row.status).toBe('tracked');
  });

  it('ledger invariant: 0 ≤ author_share ≤ gross — and author is always 0 at write (track-only)', async () => {
    await recordSpendAttribution(fakeInput({ buzzAmount: 123456 }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.grossValueCents).toBeGreaterThan(0);
    expect(data.appOwnerShareCents).toBeGreaterThanOrEqual(0);
    expect(data.appOwnerShareCents).toBeLessThanOrEqual(data.grossValueCents);
    // Track-only: no rate baked in, so the share is identically 0.
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
  });

  it('MUTATION-CHECK: author share + pct are 0 regardless of the active rate card (no rate applied)', async () => {
    // Active card defines spendSharePct=5 (a non-zero placeholder). A
    // track-only write must NOT apply it — author stays 0 and version stays
    // 'unrated' even though the card carries a real rate. If the write
    // regressed to applying computeSpendShare/the 5% card, these assertions
    // (and the not-called spy) would fail.
    expect(ACTIVE_RATE_CARD.spendSharePct).toBe(5);
    await recordSpendAttribution(fakeInput({ buzzAmount: 100000 })); // $100 gross
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.grossValueCents).toBe(10000);
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
    expect(data.rateCardVersion).toBe(UNRATED_RATE_CARD_VERSION);
    expect(computeSpendShareSpy).not.toHaveBeenCalled();
  });

  it('DORMANT per-app cap: reserves the row\'s accrued share (0 today) → no clamp, no behaviour change', async () => {
    // The per-app bounty cap is wired into the write, but while the spend flow
    // is TRACK-ONLY the accrued share is identically 0 — so the cap reserves 0,
    // grants 0, and changes nothing. This is the "dormant by construction"
    // proof at the integration point (the cap's own atomic/clamp behaviour is
    // covered in app-bounty-cap.service.test.ts).
    const res = await recordSpendAttribution(fakeInput({ buzzAmount: 100000 }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];

    // The write reserved against the per-app cap, keyed by appBlockId, with the
    // share it is about to accrue — which is 0 today (not the raw user spend).
    expect(reserveAppBountySpy).toHaveBeenCalledTimes(1);
    expect(reserveAppBountySpy).toHaveBeenCalledWith(APP_BLOCK_ID, 0);
    // Granted 0 → row's accrued share stays 0 → identical to pre-cap behaviour.
    expect(data.appOwnerShareCents).toBe(0);
    expect(res.row.appOwnerShareCents).toBe(0);
    // Successful write → no refund.
    expect(refundAppBountySpy).not.toHaveBeenCalled();
  });

  it('per-app cap reserves the BOUNTY (appOwnerShareCents), NOT the raw user spend', async () => {
    // The property that makes the cap dormant today: it reserves the row's
    // accrued share — which is 0 — and writes back the granted amount, so a
    // large user spend (here $100 of Buzz) does NOT advance the per-app counter.
    // This is what distinguishes it from the per-USER cap (which reserves raw
    // spend). If the write ever regressed to reserving `buzzAmount`/`gross`,
    // this asserts the contract breaks.
    await recordSpendAttribution(fakeInput({ buzzAmount: 100000 })); // $100 gross
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls.at(-1)![0];
    const [reservedAppBlockId, reservedShare] = reserveAppBountySpy.mock.calls.at(-1)!;
    expect(reservedAppBlockId).toBe(APP_BLOCK_ID);
    // Reserved == the bounty being written (0), NOT the gross (10000) or spend.
    expect(reservedShare).toBe(data.appOwnerShareCents);
    expect(reservedShare).toBe(0);
    expect(reservedShare).not.toBe(data.grossValueCents);
  });

  it('self-spend (spender == app owner) → voided, zero share', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue({
      id: APP_ID,
      userId: SPENDER_ID, // owner == spender
    });
    const res = await recordSpendAttribution(fakeInput());
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.status).toBe('voided');
    expect(data.voidedReason).toBe('self_spend');
    expect(data.appOwnerShareCents).toBe(0);
    expect(data.spendSharePct).toBe(0);
    expect(res.row.status).toBe('voided');
  });

  it('internal-owner (app owner ∈ internalAppOwnerUserIds) → voided, zero share', async () => {
    // The owner is a different user than the spender (so NOT self-spend), but
    // sits on the active card's internal-owner list — its rows must still be
    // voided so they never enter the backpay. Temporarily inject the owner
    // into the real list (restored after), since V5 ships with an empty list.
    const internalList = ACTIVE_RATE_CARD.internalAppOwnerUserIds;
    internalList.push(APP_OWNER_USER_ID);
    try {
      const res = await recordSpendAttribution(fakeInput());
      const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
      expect(data.status).toBe('voided');
      expect(data.voidedReason).toBe('internal_owner');
      expect(data.appOwnerShareCents).toBe(0);
      expect(data.spendSharePct).toBe(0);
      expect(res.row.status).toBe('voided');
    } finally {
      internalList.pop();
    }
  });

  it('idempotency: a second call for the same workflow returns the existing row, no second write', async () => {
    // First write succeeds.
    const first = await recordSpendAttribution(fakeInput());
    expect(first.written).toBe(true);

    // Second write hits the (workflow_id, app_block_id) UNIQUE → P2002.
    mockDbWrite.blockSpendAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('dup', 'P2002')
    );
    mockDbRead.blockSpendAttribution.findUnique.mockResolvedValueOnce({
      id: 'bsa_existing',
      status: 'pending',
      appOwnerShareCents: 25,
      spendSharePct: 5,
      grossValueCents: 500,
      rateCardVersion: 'v4',
      voidedReason: null,
    });

    const second = await recordSpendAttribution(fakeInput());
    expect(second.written).toBe(false);
    expect(second.row.id).toBe('bsa_existing');

    // Looked up by the workflow+app idempotency key.
    expect(mockDbRead.blockSpendAttribution.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowId_appBlockId: { workflowId: WORKFLOW_ID, appBlockId: APP_BLOCK_ID } },
      })
    );
  });

  it('aborts (throws AttributionAppMissingError) when the app is gone — no orphan row', async () => {
    mockDbRead.oauthClient.findUnique.mockResolvedValue(null);
    await expect(recordSpendAttribution(fakeInput())).rejects.toBeInstanceOf(
      AttributionAppMissingError
    );
    expect(mockDbWrite.blockSpendAttribution.create).not.toHaveBeenCalled();
  });

  it('re-throws a non-P2002 DB error (real failures are not swallowed as idempotent)', async () => {
    mockDbWrite.blockSpendAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('connection lost', 'P1001')
    );
    await expect(recordSpendAttribution(fakeInput())).rejects.toMatchObject({
      code: 'P1001',
    });
    // Did NOT fall through to the idempotent lookup.
    expect(mockDbRead.blockSpendAttribution.findUnique).not.toHaveBeenCalled();
  });
});

/**
 * G5 — GENERIC published-content-author attribution. When the app supplies an
 * opaque `sharedContentKey`, the CONTENT AUTHOR is resolved SERVER-SIDE from the
 * app's own shared storage (`app_<slug>.shared_kv`) and recorded as the
 * future-payout basis. Track-only; the existing app-owner attribution is
 * unchanged in every case. FULLY GENERIC — not tied to any one app kind.
 */
describe('recordSpendAttribution — content-author basis (G5)', () => {
  it('valid key → records content_author_user_id = the shared_kv row author, + the key', async () => {
    mockAppsQuery.mockResolvedValueOnce({ rows: [{ author_user_id: CONTENT_AUTHOR_ID }] });

    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];

    // The content author is the shared_kv row's author_user_id — server-resolved.
    expect(data.contentAuthorUserId).toBe(CONTENT_AUTHOR_ID);
    // The opaque key is recorded verbatim as audit context.
    expect(data.sharedContentKey).toBe(CONTENT_KEY);
    // App-owner attribution is UNCHANGED (still the OauthClient owner, share 0).
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(data.appOwnerShareCents).toBe(0);
    expect(res.written).toBe(true);

    // FORGE-SAFETY: the schema is derived from the SERVER `appBlockId`
    // (AppBlock.blockId 'blk_test' → schema "app_blk_test") and the ONLY bound
    // param is the supplied key — the author is read from the DB, never input.
    expect(mockDbRead.appBlock.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: APP_BLOCK_ID } })
    );
    const [sql, params] = mockAppsQuery.mock.calls[0];
    expect(sql).toContain('"app_blk_test".shared_kv');
    expect(sql).toContain('hidden_at IS NULL');
    expect(params).toEqual([CONTENT_KEY]);
  });

  it('absent key → content_author NULL, key NULL, shared datastore NOT queried', async () => {
    const res = await recordSpendAttribution(fakeInput()); // no sharedContentKey
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.contentAuthorUserId).toBeNull();
    expect(data.sharedContentKey).toBeNull();
    // No key → no lookup work at all (unchanged behaviour, zero extra DB work).
    expect(mockRequireAppsDb).not.toHaveBeenCalled();
    expect(mockAppsQuery).not.toHaveBeenCalled();
    expect(mockDbRead.appBlock.findUnique).not.toHaveBeenCalled();
    // App-owner attribution unchanged.
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(res.written).toBe(true);
  });

  it('non-existent key (no row) → content_author NULL; app-owner attribution unchanged', async () => {
    mockAppsQuery.mockResolvedValueOnce({ rows: [] });
    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: 'k_missing' }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.contentAuthorUserId).toBeNull();
    // The supplied key is still recorded (opaque audit context).
    expect(data.sharedContentKey).toBe('k_missing');
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(res.written).toBe(true);
  });

  it('hidden row → excluded by the query (hidden_at IS NULL) → content_author NULL', async () => {
    // A hidden row returns no result from the `hidden_at IS NULL` filter.
    mockAppsQuery.mockResolvedValueOnce({ rows: [] });
    await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.contentAuthorUserId).toBeNull();
    expect(mockAppsQuery.mock.calls[0][0]).toContain('hidden_at IS NULL');
  });

  it('self-author (content author == spender) → content_author NULL', async () => {
    mockAppsQuery.mockResolvedValueOnce({ rows: [{ author_user_id: SPENDER_ID }] });
    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.contentAuthorUserId).toBeNull();
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(res.written).toBe(true);
  });

  it('owner-author (content author == app owner) → content_author NULL (already app-owner-attributed)', async () => {
    mockAppsQuery.mockResolvedValueOnce({ rows: [{ author_user_id: APP_OWNER_USER_ID }] });
    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(data.contentAuthorUserId).toBeNull();
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
    expect(res.written).toBe(true);
  });

  it('FORGE-SAFETY: a client cannot influence the recorded author — it is read from the key, not the body', async () => {
    // The input carries NO author field; even a hostile body pointing the key at
    // a valuable account only credits whoever the DB row says authored it.
    mockAppsQuery.mockResolvedValueOnce({ rows: [{ author_user_id: CONTENT_AUTHOR_ID }] });
    // Sneak an extra (ignored) property onto the input — it must NOT leak through.
    const hostile = {
      ...fakeInput({ sharedContentKey: CONTENT_KEY }),
      contentAuthorUserId: 4242, // attacker-chosen; not part of the input contract
    } as RecordSpendAttributionInput;
    await recordSpendAttribution(hostile);
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    // Recorded author is the DB row's author (777), NOT the injected 4242.
    expect(data.contentAuthorUserId).toBe(CONTENT_AUTHOR_ID);
    expect(data.contentAuthorUserId).not.toBe(4242);
  });

  it('a shared-datastore lookup FAILURE degrades to NULL — never throws into the write', async () => {
    mockAppsQuery.mockRejectedValueOnce(new Error('apps db down'));
    // The write must still succeed with a NULL content author.
    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(res.written).toBe(true);
    expect(data.contentAuthorUserId).toBeNull();
    expect(data.appOwnerUserId).toBe(APP_OWNER_USER_ID);
  });

  it('shared datastore unavailable (requireAppsDb throws) → NULL, still writes', async () => {
    mockRequireAppsDb.mockImplementationOnce(() => {
      throw new Error('APPS_DATABASE_URL is not configured');
    });
    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(res.written).toBe(true);
    expect(data.contentAuthorUserId).toBeNull();
  });

  it('appBlock/slug unresolvable → NULL, still writes', async () => {
    mockDbRead.appBlock.findUnique.mockResolvedValueOnce(null);
    const res = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    const { data } = mockDbWrite.blockSpendAttribution.create.mock.calls[0][0];
    expect(res.written).toBe(true);
    expect(data.contentAuthorUserId).toBeNull();
    // Never reached the datastore query.
    expect(mockAppsQuery).not.toHaveBeenCalled();
  });

  it('idempotency preserved with a key: a duplicate returns the existing row, no second write', async () => {
    mockAppsQuery.mockResolvedValue({ rows: [{ author_user_id: CONTENT_AUTHOR_ID }] });
    const first = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    expect(first.written).toBe(true);

    mockDbWrite.blockSpendAttribution.create.mockRejectedValueOnce(
      new FakePrismaKnownError('dup', 'P2002')
    );
    mockDbRead.blockSpendAttribution.findUnique.mockResolvedValueOnce({
      id: 'bsa_existing',
      status: 'tracked',
      appOwnerShareCents: 0,
      spendSharePct: 0,
      grossValueCents: 500,
      rateCardVersion: 'unrated',
      voidedReason: null,
    });
    const second = await recordSpendAttribution(fakeInput({ sharedContentKey: CONTENT_KEY }));
    expect(second.written).toBe(false);
    expect(second.row.id).toBe('bsa_existing');
    expect(mockDbRead.blockSpendAttribution.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workflowId_appBlockId: { workflowId: WORKFLOW_ID, appBlockId: APP_BLOCK_ID } },
      })
    );
  });
});
