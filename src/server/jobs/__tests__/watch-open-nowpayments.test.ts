import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const { watchOpenDeposits, sendDigest } = vi.hoisted(() => ({
  watchOpenDeposits: vi.fn(),
  sendDigest: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/nowpayments.service', () => ({ watchOpenDeposits }));
vi.mock('~/server/email/templates/openCryptoDepositDigest.email', () => ({
  openCryptoDepositDigestEmail: { send: sendDigest },
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({
    name,
    cron,
    run: () => ({ result: fn(), cancel: () => Promise.resolve() }),
    options: {},
  }),
}));

import { watchOpenNowpaymentsJob } from '~/server/jobs/watch-open-nowpayments';

const counts = { open: 1, oldestOpenDays: 4, held: 0, finishedUncredited: 0 };
const noLedgerMisses = { missing: [], lookupFailed: 0, failedIds: [], notChecked: 0 };
const item = {
  paymentId: '1000000001',
  userId: 1,
  username: 'tester',
  status: 'confirmed',
  payCurrency: 'btc',
  payAmount: 1,
  daysOpen: 4,
  held: false,
};
const run = () => watchOpenNowpaymentsJob.run({}).result as Promise<Record<string, unknown>>;

beforeEach(() => {
  vi.clearAllMocks();
  sendDigest.mockReset().mockResolvedValue(undefined);
});

describe('watch-open-nowpayments job', () => {
  it('mails the digest to the support inbox when rows have been open 3+ days', async () => {
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 1,
      closed: 0,
      lookupFailed: 0,
      counts,
      digest: [item],
      listed: [],
      ledger: noLedgerMisses,
    });

    const result = await run();

    expect(sendDigest).toHaveBeenCalledWith({
      to: 'hello@civitai.com',
      items: [item],
      listed: [],
      ledger: noLedgerMisses,
      counts,
    });
    expect(result).toMatchObject({ digestSent: 1, counts });
  });

  it('sends no digest when nothing has been open 3+ days', async () => {
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 2,
      closed: 2,
      lookupFailed: 0,
      counts: { ...counts, open: 0, oldestOpenDays: 0 },
      digest: [],
      listed: [],
      ledger: noLedgerMisses,
    });

    const result = await run();

    expect(sendDigest).not.toHaveBeenCalled();
    expect(result.digestSent).toBe(0);
  });

  it('mails the digest for listed payment ids even when no row has been open 3+ days', async () => {
    const listed = [{ paymentId: '1000000002', state: 'awaiting_ok', status: 'finished' }];
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 0,
      closed: 0,
      lookupFailed: 0,
      counts: { ...counts, open: 0, oldestOpenDays: 0 },
      digest: [],
      listed,
      ledger: noLedgerMisses,
    });

    const result = await run();

    expect(sendDigest).toHaveBeenCalledWith(expect.objectContaining({ items: [], listed }));
    expect(result.listed).toEqual(listed);
  });

  it('mails the digest and warns when a credited deposit is missing from the ledger', async () => {
    const ledger = {
      missing: [
        {
          paymentId: '1000000003',
          userId: 1,
          username: 'tester',
          status: 'finished',
          buzzCredited: 5000,
        },
      ],
      lookupFailed: 0,
      failedIds: [],
      notChecked: 0,
    };
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 0,
      closed: 0,
      lookupFailed: 0,
      counts: { ...counts, open: 0, oldestOpenDays: 0 },
      digest: [],
      listed: [],
      ledger,
    });

    await run();

    expect(sendDigest).toHaveBeenCalledWith(expect.objectContaining({ items: [], ledger }));
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', creditedNotInLedger: 1 })
    );
  });

  it.each([
    ['a ledger lookup failed', { ...noLedgerMisses, lookupFailed: 1, failedIds: ['1000000004'] }],
    ['the ledger check did not run', { ...noLedgerMisses, error: 'db down' }],
  ])('mails the digest when %s, though nothing is missing', async (_, ledger) => {
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 0,
      closed: 0,
      lookupFailed: 0,
      counts: { ...counts, open: 0, oldestOpenDays: 0 },
      digest: [],
      listed: [],
      ledger,
    });

    await run();

    expect(sendDigest).toHaveBeenCalledWith(expect.objectContaining({ ledger }));
  });

  it('finishes and logs the error when the digest cannot be sent', async () => {
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 1,
      closed: 0,
      lookupFailed: 0,
      counts,
      digest: [item],
      listed: [],
      ledger: noLedgerMisses,
    });
    sendDigest.mockRejectedValueOnce(new Error('smtp down'));

    const result = await run();

    expect(result.digestSent).toBe(0);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to send open-deposit digest' })
    );
  });
});
