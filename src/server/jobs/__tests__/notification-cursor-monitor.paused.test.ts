import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: () => Promise<unknown>) => ({ name, cron, run: fn }),
}));

const { notificationCursorMonitor } = await import('~/server/jobs/notification-cursor-monitor');
const { PAUSED_NOTIFICATION_TYPES_KEY } = await import('~/server/jobs/paused-notification-types');

const twoHoursAgo = () => Date.now() - 2 * 60 * 60_000;
const flaggedKeys = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([arg]: [{ name?: string; details?: { key?: string } }]) => arg)
    .filter((arg) => arg.name === 'Notification cursor stale')
    .map((arg) => arg.details?.key);

beforeEach(() => {
  loggingMock.logToAxiom.mockClear();
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    { key: 'last-sent-notification-new-model-version', value: twoHoursAgo() },
    { key: 'last-sent-notification-new-model-from-following', value: twoHoursAgo() },
  ] as never);
});

describe('notification-cursor-monitor and paused types', () => {
  it('does not flag a paused type, still flags another stale type', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockImplementation((async ({
      where,
    }: {
      where: { key: string };
    }) =>
      where.key === PAUSED_NOTIFICATION_TYPES_KEY
        ? { key: where.key, value: ['new-model-version'] }
        : null) as never);
    await notificationCursorMonitor.run();

    expect(flaggedKeys()).toEqual(['last-sent-notification-new-model-from-following']);
  });

  it('flags both when nothing is paused', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null as never);
    await notificationCursorMonitor.run();

    expect(flaggedKeys()).toEqual([
      'last-sent-notification-new-model-version',
      'last-sent-notification-new-model-from-following',
    ]);
  });
});
