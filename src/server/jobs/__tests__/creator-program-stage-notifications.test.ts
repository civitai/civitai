import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { NotificationCategory } from '~/server/common/enums';

const STAGE_JOBS = [
  bankingPhaseEndingNotification,
  extractionPhaseStartedNotification,
  extractionPhaseEndingNotification,
];

// Active members (the only ones banking-ending goes to) are user 1; everyone is users 1 and 2.
// The membership filter is an interpolated Prisma.sql fragment, so its text is in the values.
function queryRawFake(strings: TemplateStringsArray, ...values: unknown[]) {
  const sql = [...strings, ...values.map((v) => (v as { strings?: string[] })?.strings ?? [])]
    .flat()
    .join('?');
  return Promise.resolve(
    sql.includes('CustomerSubscription') ? [{ userId: 1 }] : [{ userId: 1 }, { userId: 2 }]
  );
}

// Runs every stage job at 00:05:06Z (its cron plus scheduler lag) on each UTC day of the month,
// and records what each notification type sent and on which UTC day of the month.
async function runMonth(year: number, monthIndex: number) {
  const fired: Record<string, unknown[]> = {};
  mocks.createNotification.mockImplementation(async (input: Record<string, unknown>) => {
    const { type, ...rest } = input;
    (fired[type as string] ??= []).push({ day: new Date().getUTCDate(), ...rest });
  });

  const length = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  for (let d = 1; d <= length; d++) {
    vi.setSystemTime(new Date(Date.UTC(year, monthIndex, d, 0, 5, 6)));
    for (const job of STAGE_JOBS) await job.run({}).result;
  }
  return fired;
}

const sent = (day: number, key: string, userIds: number[]) => [
  { day, key, userIds, category: NotificationCategory.Creator, details: {} },
];

// West of UTC, 00:05Z is still the previous local day, so a local-time slip moves every send
// a day early here. CI runs in UTC, where local and UTC agree and such a slip would pass.
beforeAll(() => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  mocks.createNotification.mockReset();
  dbMock.dbWrite.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockImplementation(queryRawFake as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('creator program stage notification jobs', () => {
  it('runs with a local timezone west of UTC', () => {
    expect(new Date(Date.UTC(2026, 8, 27, 0, 5)).getDate()).toBe(26);
  });

  it.each([
    // Sep 2026 is the month banking-ending went out on the 26th.
    { label: '30-day', year: 2026, month: 8, ym: '2026-09', bank: 27, start: 28, end: 30 },
    { label: '31-day', year: 2026, month: 9, ym: '2026-10', bank: 28, start: 29, end: 31 },
    { label: 'February', year: 2027, month: 1, ym: '2027-02', bank: 25, start: 26, end: 28 },
  ])(
    '$label month: each stage notifies its audience once, on the getPhases day',
    async ({ year, month, ym, bank, start, end }) => {
      const fired = await runMonth(year, month);
      // Recipients are queried only on a send day, not on every daily run.
      expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(3);
      expect(fired).toEqual({
        'creator-program-banking-phase-ending': sent(
          bank,
          `creator-program-banking-phase-ending:${ym}`,
          [1]
        ),
        'creator-program-extraction-phase-started': sent(
          start,
          `creator-program-extraction-phase-started:${ym}`,
          [1, 2]
        ),
        'creator-program-extraction-phase-ending': sent(
          end,
          `creator-program-extraction-phase-ending:${ym}`,
          [1, 2]
        ),
      });
    }
  );

  it('runs daily, off midnight, under names the scheduler had not registered before', () => {
    const scheduled = creatorProgramJobs.map(({ name, cron }) => ({ name, cron }));
    expect(STAGE_JOBS.map(({ name, cron }) => ({ name, cron }))).toEqual([
      { name: 'creator-program-notify-banking-phase-ending', cron: '5 0 * * *' },
      { name: 'creator-program-notify-extraction-phase-started', cron: '5 0 * * *' },
      { name: 'creator-program-notify-extraction-phase-ending', cron: '5 0 * * *' },
    ]);
    for (const job of STAGE_JOBS) {
      expect(scheduled).toContainEqual({ name: job.name, cron: job.cron });
    }
    // After these jobs' `L-n` crons changed, the scheduler still fired them on the old days.
    // Reusing a name risks the daily cron never being registered, which with the getPhases
    // gate means the notification is never sent at all.
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
