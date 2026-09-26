import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NotificationService from '~/server/services/notification.service';

const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
}));

vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: mocks.createNotification,
}));

import {
  bankingPhaseEndingNotification,
  creatorProgramJobs,
  extractionPhaseEndingNotification,
  extractionPhaseStartedNotification,
} from '~/server/jobs/creators-program-jobs';
import { dbMock } from '~/__tests__/mocks/db.mock';

const STAGE_JOBS = [
  bankingPhaseEndingNotification,
  extractionPhaseStartedNotification,
  extractionPhaseEndingNotification,
];

// Runs every stage job at 00:00:06Z (scheduler lag) on each UTC day of the month, and records
// the day of month each notification type was created on, with its dedupe key.
async function runMonth(year: number, monthIndex: number) {
  const fired: Record<string, string[]> = {};
  mocks.createNotification.mockImplementation(async (input: unknown) => {
    const { type, key } = input as { type: string; key: string };
    (fired[type] ??= []).push(`${new Date().getUTCDate()} ${key}`);
  });

  const length = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = 1; d <= length; d++) {
    vi.setSystemTime(new Date(Date.UTC(year, monthIndex, d, 0, 0, 6)));
    for (const job of STAGE_JOBS) await job.run({}).result;
  }
  return fired;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  mocks.createNotification.mockReset();
  dbMock.dbWrite.$queryRaw.mockClear();
  dbMock.dbWrite.$queryRaw.mockResolvedValue([{ userId: 1 }, { userId: 2 }]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('creator program stage notification jobs', () => {
  it.each([
    // Sep 2026 is the month banking-ending went out on the 26th.
    { label: '30-day', year: 2026, month: 8, ym: '2026-09', bank: 27, start: 28, end: 30 },
    { label: '31-day', year: 2026, month: 9, ym: '2026-10', bank: 28, start: 29, end: 31 },
    { label: 'February', year: 2027, month: 1, ym: '2027-02', bank: 25, start: 26, end: 28 },
  ])(
    '$label month: each stage notifies once, on the getPhases day',
    async ({ year, month, ym, bank, start, end }) => {
      expect(await runMonth(year, month)).toEqual({
        'creator-program-banking-phase-ending': [
          `${bank} creator-program-banking-phase-ending:${ym}`,
        ],
        'creator-program-extraction-phase-started': [
          `${start} creator-program-extraction-phase-started:${ym}`,
        ],
        'creator-program-extraction-phase-ending': [
          `${end} creator-program-extraction-phase-ending:${ym}`,
        ],
      });
    }
  );

  it('banking-ending goes only to active members; the extraction notices go to everyone', async () => {
    await runMonth(2026, 8);
    // The membership filter is an interpolated Prisma.sql fragment, so read the values too.
    const sql = dbMock.dbWrite.$queryRaw.mock.calls.map(([strings, ...values]) =>
      [
        ...(strings as TemplateStringsArray),
        ...values.map((v) => ((v as { strings?: string[] })?.strings ?? []).join('?')),
      ].join('?')
    );
    // One query per sent notification, in send order: banking-ending is the earliest day.
    expect(sql.map((q) => q.includes('CustomerSubscription'))).toEqual([true, false, false]);
  });

  it('runs daily under names the scheduler had not registered before', () => {
    const scheduled = creatorProgramJobs.map(({ name, cron }) => ({ name, cron }));
    for (const job of STAGE_JOBS) {
      expect(scheduled).toContainEqual({ name: job.name, cron: '0 0 * * *' });
    }
    // The scheduler kept firing a stale `L-n` trigger registered under these names after their
    // crons changed. Reusing a name risks the daily cron never being registered, which with the
    // getPhases gate means the notification is never sent at all.
    const names = scheduled.map((j) => j.name);
    for (const retired of [
      'creator-program-banking-phase-ending',
      'creator-program-extraction-phase-started',
      'creator-program-extraction-phase-ending',
    ]) {
      expect(names).not.toContain(retired);
    }
  });
});
