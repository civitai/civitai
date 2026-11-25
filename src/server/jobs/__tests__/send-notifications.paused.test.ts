import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const h = vi.hoisted(() => ({ captured: [] as string[] }));

// No ClickHouse, so the exclusion list reads as empty.
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));

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
/** How many times the real getJobDate wrote this KeyValue cursor. */
const cursorWrites = (key: string) =>
  dbMock.dbWrite.keyValue.upsert.mock.calls.filter(
    (call) => (call[0] as { where: { key: string } }).where.key === key
  ).length;

function storePausedRow(value: unknown) {
  dbMock.dbWrite.keyValue.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { key: string };
  }) => (where.key === PAUSED_NOTIFICATION_TYPES_KEY ? { key: where.key, value } : null)) as never);
}

const run = () => sendNotificationsJob.run({}).result;

beforeEach(() => {
  h.captured.length = 0;
  dbMock.dbWrite.keyValue.findUnique.mockReset();
  dbMock.dbWrite.keyValue.upsert.mockReset();
  dbMock.dbWrite.keyValue.upsert.mockResolvedValue({} as never);
});

describe('send-notifications paused-notification-types', () => {
  it('without the row, both types query and advance their cursors', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null as never);
    await run();

    expect(queriesFor(PAUSED)).toHaveLength(1);
    expect(cursorWrites('last-sent-notification-' + PAUSED)).toBe(1);
    expect(queriesFor(RUNNING)).toHaveLength(1);
    expect(cursorWrites('last-sent-notification-' + RUNNING)).toBe(1);
  });

  it('a paused type sends nothing and keeps its cursor while another type still runs', async () => {
    storePausedRow([PAUSED]);
    await run();

    expect(queriesFor(PAUSED)).toHaveLength(0);
    expect(cursorWrites('last-sent-notification-' + PAUSED)).toBe(0);
    expect(queriesFor(RUNNING)).toHaveLength(1);
    expect(cursorWrites('last-sent-notification-' + RUNNING)).toBe(1);
    expect(cursorWrites('last-sent-notifications')).toBe(1);
  });

  it('a malformed row sends nothing at all', async () => {
    storePausedRow(PAUSED);
    await run();

    expect(h.captured).toHaveLength(0);
    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });
});
