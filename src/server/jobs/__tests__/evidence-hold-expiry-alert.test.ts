import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  countEvidenceHoldsEnding: vi.fn(),
  sendEmail: vi.fn(async () => undefined),
  isEmailConfigured: vi.fn(() => true),
}));

vi.mock('@civitai/db-queries/evidence-hold', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countEvidenceHoldsEnding: mocks.countEvidenceHoldsEnding,
}));
vi.mock('~/server/db/kyselyDb', () => ({ kyselyRead: {} }));
vi.mock('~/server/email/client', () => ({
  sendEmail: mocks.sendEmail,
  isEmailConfigured: mocks.isEmailConfigured,
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

import { evidenceHoldExpiryAlertJob } from '~/server/jobs/evidence-hold-expiry-alert';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const RECIPIENTS = ['legal@example.test', 'trust@example.test'];
// Just past midnight UTC: a local date west of UTC would name the day before.
const EARLIEST = new Date('2026-10-26T00:30:00Z');
const LINK = 'https://mod.example.test/evidence-holds';
const SUMMARY =
  '3 owner(s) with an evidence hold ending within 14 days, the earliest on 2026-10-26 (UTC).';

const run = () => evidenceHoldExpiryAlertJob.run() as Promise<{ owners: number; sent: boolean }>;
const axiom = (type: string) =>
  loggingMock.logToAxiom.mock.calls
    .map(([arg]) => arg as { type: string; name: string; message: string; owners?: number })
    .filter((arg) => arg.name === 'evidence-hold-expiry-alert' && arg.type === type);

beforeEach(() => {
  vi.clearAllMocks();
  loggingMock.logToAxiom.mockClear();
  setEnv({
    EVIDENCE_HOLD_ALERT_EMAILS: RECIPIENTS,
    MODERATOR_APP_URL: 'https://mod.example.test',
  });
  mocks.isEmailConfigured.mockReturnValue(true);
  mocks.countEvidenceHoldsEnding.mockResolvedValue({ owners: 3, earliest: EARLIEST });
});

describe('evidence-hold-expiry-alert wiring', () => {
  // The entry in the `jobs` array is the scheduling: drop it and nothing else fails, the alert just
  // never runs. Read as source because importing the route pulls in every job.
  it('is registered in the jobs array the scheduler reads', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../../pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    const start = source.indexOf('export const jobs: Job[] = [');
    expect(start).toBeGreaterThan(-1);
    const jobs = source.slice(start, source.indexOf('];', start));
    expect(jobs).toMatch(/^\s*evidenceHoldExpiryAlertJob,$/m);
    expect(evidenceHoldExpiryAlertJob.cron).toBe('0 9 * * *');
  });
});

describe('evidence-hold-expiry-alert', () => {
  it('emails the configured recipients the count, the earliest date and the page, nothing else', async () => {
    await expect(run()).resolves.toEqual({ owners: 3, sent: true });

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    // Whole-message equality: anything added, an id or a policy word, fails here.
    expect(mocks.sendEmail.mock.calls[0][0]).toEqual({
      to: RECIPIENTS,
      subject: 'Evidence holds ending soon: 3',
      html: `<p>${SUMMARY}</p><p>Review: <a href="${LINK}">${LINK}</a></p>`,
      text: `${SUMMARY}\n\nReview: ${LINK}`,
    });
  });

  it('logs the count and sends nothing when no hold is ending', async () => {
    mocks.countEvidenceHoldsEnding.mockResolvedValue({ owners: 0, earliest: null });

    await expect(run()).resolves.toEqual({ owners: 0, sent: false });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(axiom('info')).toEqual([expect.objectContaining({ owners: 0 })]);
    expect(axiom('error')).toEqual([]);
  });

  it.each([
    ['unset', []],
    ['set but empty', ['']],
  ])(
    'logs an error every run when the recipient list is %s, even with nothing ending',
    async (_, value) => {
      setEnv({ EVIDENCE_HOLD_ALERT_EMAILS: value });
      mocks.countEvidenceHoldsEnding.mockResolvedValue({ owners: 0, earliest: null });

      await run();
      await run();

      expect(mocks.sendEmail).not.toHaveBeenCalled();
      expect(axiom('error').map((e) => e.message)).toEqual([
        'Evidence hold expiry alert cannot be sent: EVIDENCE_HOLD_ALERT_EMAILS is not set',
        'Evidence hold expiry alert cannot be sent: EVIDENCE_HOLD_ALERT_EMAILS is not set',
      ]);
    }
  );

  it('logs an error instead of reporting a send when email itself is not configured', async () => {
    mocks.isEmailConfigured.mockReturnValue(false);

    await expect(run()).resolves.toEqual({ owners: 3, sent: false });

    expect(mocks.sendEmail).not.toHaveBeenCalled();
    expect(axiom('error').map((e) => e.message)).toEqual([
      'Evidence hold expiry alert cannot be sent: email is not configured',
    ]);
  });

  it('fails the run when the send fails', async () => {
    mocks.sendEmail.mockRejectedValueOnce(new Error('rejected'));

    await expect(run()).rejects.toThrow('rejected');
  });
});
