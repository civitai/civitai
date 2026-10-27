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
    });

    const result = await run();

    expect(sendDigest).toHaveBeenCalledWith({ to: 'hello@civitai.com', items: [item], counts });
    expect(result).toMatchObject({ digestSent: 1, counts });
  });

  it('sends no digest when nothing has been open 3+ days', async () => {
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 2,
      closed: 2,
      lookupFailed: 0,
      counts: { ...counts, open: 0, oldestOpenDays: 0 },
      digest: [],
    });

    const result = await run();

    expect(sendDigest).not.toHaveBeenCalled();
    expect(result.digestSent).toBe(0);
  });

  it('finishes and logs the error when the digest cannot be sent', async () => {
    watchOpenDeposits.mockResolvedValueOnce({
      checked: 1,
      closed: 0,
      lookupFailed: 0,
      counts,
      digest: [item],
    });
    sendDigest.mockRejectedValueOnce(new Error('smtp down'));

    const result = await run();

    expect(result.digestSent).toBe(0);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to send open-deposit digest' })
    );
  });
});
