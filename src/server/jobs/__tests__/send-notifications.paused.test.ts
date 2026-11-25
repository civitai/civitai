import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const h = vi.hoisted(() => ({
  captured: [] as string[],
  setters: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock('~/server/jobs/job', () => ({
  createJob: (name: string, cron: string, fn: (e: unknown) => Promise<unknown>) => ({
    name,
    cron,
    run: () => fn({ checkIfCanceled: () => undefined, on: () => undefined }),
  }),
  getJobDate: vi.fn(async (key: string) => {
    const set = vi.fn();
    h.setters.set(key, set);
    return [new Date(0), set];
  }),
}));

vi.mock('~/server/services/metric-excluded-users.service', () => ({
  getMetricExcludedUserIds: vi.fn().mockResolvedValue([]),
}));

vi.mock('~/server/db/pgDb', () => ({
  pgDbRead: {
    cancellableQuery: vi.fn(async (sql: string) => {
      h.captured.push(sql);
      return { result: async () => [], cancel: async () => undefined };
    }),
  },
  pgDbReadLong: {},
  pgDbWrite: {},
}));

const { sendNotificationsJob } = await import('~/server/jobs/send-notifications');
const { PAUSED_NOTIFICATION_TYPES_KEY } = await import('~/server/jobs/paused-notification-types');

const PAUSED = 'new-model-version';
const RUNNING = 'new-model-from-following';
const queriesFor = (type: string) => h.captured.filter((s) => s.includes(`'${type}' "type"`));
const cursor = (type: string) => h.setters.get('last-sent-notification-' + type);

function storePausedRow(value: unknown) {
  dbMock.dbWrite.keyValue.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { key: string };
  }) => (where.key === PAUSED_NOTIFICATION_TYPES_KEY ? { key: where.key, value } : null)) as never);
}

beforeEach(() => {
  h.captured.length = 0;
  h.setters.clear();
  dbMock.dbWrite.keyValue.findUnique.mockReset();
});

describe('send-notifications paused-notification-types', () => {
  it('without the row, both types query and advance their cursors', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null as never);
    await sendNotificationsJob.run();

    expect(queriesFor(PAUSED)).toHaveLength(1);
    expect(cursor(PAUSED)).toHaveBeenCalledTimes(1);
    expect(queriesFor(RUNNING)).toHaveLength(1);
    expect(cursor(RUNNING)).toHaveBeenCalledTimes(1);
  });

  it('a paused type sends nothing and keeps its cursor while another type still runs', async () => {
    storePausedRow([PAUSED]);
    await sendNotificationsJob.run();

    expect(queriesFor(PAUSED)).toHaveLength(0);
    expect(cursor(PAUSED)?.mock.calls.length ?? 0).toBe(0);
    expect(queriesFor(RUNNING)).toHaveLength(1);
    expect(cursor(RUNNING)).toHaveBeenCalledTimes(1);
    expect(h.setters.get('last-sent-notifications')).toHaveBeenCalledTimes(1);
  });

  it('a malformed row sends nothing at all', async () => {
    storePausedRow(PAUSED);
    await sendNotificationsJob.run();

    expect(h.captured).toHaveLength(0);
    expect(h.setters.get('last-sent-notifications')?.mock.calls.length ?? 0).toBe(0);
  });
});
