import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import type * as CreatorProgramService from '~/server/services/creator-program.service';

const { bust, getPaymentByRefCode, updateCashWithdrawal, validateWebhookEvent } = vi.hoisted(
  () => ({
    getPaymentByRefCode: vi.fn(),
    bust: vi.fn(async () => undefined),
    updateCashWithdrawal: vi.fn(async () => undefined),
    validateWebhookEvent: vi.fn(() => ({ isValid: true })),
  })
);

vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  trackWebhookEvent: vi.fn(() => Promise.resolve()),
}));
vi.mock('~/server/http/tipalti/tipalti.caller', () => ({
  default: async () => ({ validateWebhookEvent, getPaymentByRefCode }),
}));
vi.mock('~/server/services/creator-program.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CreatorProgramService>()),
  userCashCache: { bust },
  updateCashWithdrawal,
}));

const handler = (await import('~/pages/api/webhooks/tipalti')).default;

type Row = { id: string; userId: number; status: string; metadata: Record<string, unknown> };
let rows: Row[] = [];

// A small in-memory stand-in for the CashWithdrawal table, covering the where shapes the
// webhook uses. It throws on any other key, so a query it cannot interpret fails loudly
// instead of matching everything.
const KNOWN_KEYS = new Set(['userId', 'id', 'status', 'metadata']);
const matches = (row: Row, where: Record<string, any>) => {
  const unknown = Object.keys(where).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length) throw new Error(`fake cashWithdrawal cannot filter on ${unknown}`);
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.id?.startsWith !== undefined && !row.id.startsWith(where.id.startsWith)) return false;
  if (where.status?.not !== undefined && row.status === where.status.not) return false;
  if (where.status?.notIn !== undefined && where.status.notIn.includes(row.status)) return false;
  if (where.metadata?.path) {
    const value = where.metadata.path.reduce((acc: any, key: string) => acc?.[key], row.metadata);
    if (value !== where.metadata.equals) return false;
  }
  return true;
};

const userId = 1234567;
// Legacy refCodes were `CW${userId}_${id}`.slice(0, 16): a 7-digit userId keeps 6 id chars.
const legacyCode = `CW${userId}_cm7o3q`;

const run = async (eventData: Record<string, unknown>, type = 'paymentCompleted') => {
  const body = JSON.stringify({ id: 'evt-1', type, eventData });
  const req = {
    method: 'POST',
    headers: { 'tipalti-signature': 'sig' },
    body,
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
  let statusCode = 0;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json: () => res,
    send: () => res,
    setHeader: () => res,
    end: () => res,
    once: () => res,
    _status: () => statusCode,
  };
  await handler(req as never, res as never);
  return res;
};

const refusals = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([entry]) => entry as { name?: string; candidateIds?: string[] })
    .filter((entry) => entry.name === 'tipalti-refcode-ambiguous');

const updatedIds = () =>
  updateCashWithdrawal.mock.calls.map(
    (call) => (call as unknown as [{ withdrawalId: string }])[0].withdrawalId
  );

beforeEach(() => {
  vi.clearAllMocks();
  validateWebhookEvent.mockReset().mockReturnValue({ isValid: true });
  setEnv({ TIPALTI_WEBTOKEN_SECRET: 'secret' });
  rows = [];
  dbMock.dbWrite.cashWithdrawal.findMany.mockImplementation(
    async ({ where }: { where: Record<string, any> }) => rows.filter((r) => matches(r, where))
  );
});

describe('tipalti webhook: cash withdrawal refCode matching', () => {
  it('does not update either withdrawal when two share the same sent refCode', async () => {
    // Two withdrawals minutes apart: their cuids share the timestamp prefix, so both were
    // sent to Tipalti with the same truncated refCode. The event cannot say which one it is.
    rows = [
      {
        id: 'cm7o3qaaaa0000',
        userId,
        status: 'InternalValue',
        metadata: { paymentRefCode: legacyCode },
      },
      {
        id: 'cm7o3qbbbb0000',
        userId,
        status: 'InternalValue',
        metadata: { paymentRefCode: legacyCode },
      },
    ];

    const res = await run({ refCode: legacyCode, paymentStatus: 'Paid' });

    expect(updatedIds()).toEqual([]);
    expect(res._status()).toBe(400);
    expect(refusals().map((r) => r.candidateIds)).toEqual([['cm7o3qaaaa0000', 'cm7o3qbbbb0000']]);
  });

  it('updates the withdrawal whose stored refCode is the one Tipalti sent', async () => {
    const sent = `CW${userId}_k3x9q`;
    rows = [
      { id: 'cm7o3qaaaa0000', userId, status: 'Paid', metadata: { paymentRefCode: legacyCode } },
      { id: 'cm7o3qbbbb0000', userId, status: 'InternalValue', metadata: { paymentRefCode: sent } },
    ];

    const res = await run({ refCode: sent, paymentStatus: 'Paid' });

    expect(updatedIds()).toEqual(['cm7o3qbbbb0000']);
    expect(res._status()).toBe(200);
  });

  it('ignores a FailedFee row that copied its parent refCode', async () => {
    rows = [
      {
        id: 'cfeerow0000000',
        userId,
        status: 'FailedFee',
        metadata: { paymentRefCode: legacyCode },
      },
      {
        id: 'cm7o3qaaaa0000',
        userId,
        status: 'Rejected',
        metadata: { paymentRefCode: legacyCode },
      },
    ];

    await run({ refCode: legacyCode, paymentStatus: 'Canceled' }, 'paymentCanceled');

    expect(updatedIds()).toEqual(['cm7o3qaaaa0000']);
  });

  it('falls back to the id prefix for a row with no stored refCode, and refuses two', async () => {
    rows = [{ id: 'cm7o3qaaaa0000', userId, status: 'InternalValue', metadata: {} }];
    await run({ refCode: legacyCode, paymentStatus: 'Paid' });
    expect(updatedIds()).toEqual(['cm7o3qaaaa0000']);

    updateCashWithdrawal.mockClear();
    rows.push({ id: 'cm7o3qbbbb0000', userId, status: 'InternalValue', metadata: {} });
    const res = await run({ refCode: legacyCode, paymentStatus: 'Paid' });
    expect(updatedIds()).toEqual([]);
    expect(res._status()).toBe(400);
    expect(refusals()).toHaveLength(1);
  });

  it('never falls back to a row that stored a different code', async () => {
    rows = [
      {
        id: 'cm7o3qaaaa0000',
        userId,
        status: 'InternalValue',
        metadata: { paymentRefCode: `CW${userId}_zz9zz` },
      },
    ];

    const res = await run({ refCode: legacyCode, paymentStatus: 'Paid' });

    expect(updatedIds()).toEqual([]);
    expect(res._status()).toBe(400);
    expect(refusals()).toEqual([]);
  });

  it('never refunds a Reclaimed moderator adjustment through the fallback', async () => {
    rows = [
      { id: 'cm7o3qaaaa0000', userId, status: 'Reclaimed', metadata: { modUserId: 1 } },
      { id: 'cm7o3qbbbb0000', userId, status: 'InternalValue', metadata: {} },
    ];

    await run({ refCode: legacyCode, paymentStatus: 'Canceled' }, 'paymentCanceled');

    expect(updatedIds()).toEqual(['cm7o3qbbbb0000']);
  });

  it('matches a stored legacy code the strict parser rejects', async () => {
    const colonCode = `CW${userId}:cm7o3q`;
    rows = [
      {
        id: 'cm7o3qaaaa0000',
        userId,
        status: 'InternalValue',
        metadata: { paymentRefCode: colonCode },
      },
    ];

    await run({ refCode: colonCode, paymentStatus: 'Paid' });

    expect(updatedIds()).toEqual(['cm7o3qaaaa0000']);
  });

  // The paymentError branch refunds fees from Tipalti's payment record; without it, refund nothing.
  it('records nothing when the Tipalti payment record cannot be fetched', async () => {
    rows = [
      {
        id: 'cm7o3qaaaa0000',
        userId,
        status: 'Scheduled',
        metadata: { paymentRefCode: legacyCode },
      },
    ];
    getPaymentByRefCode.mockRejectedValueOnce(new Error('Failed to get payment by refCode: 500'));

    const res = await run({ refCode: legacyCode, paymentStatus: 'Failed' }, 'paymentError');

    expect(getPaymentByRefCode).toHaveBeenCalledWith(legacyCode);
    expect(updatedIds()).toEqual([]);
    expect(res._status()).toBe(400);
  });
});
