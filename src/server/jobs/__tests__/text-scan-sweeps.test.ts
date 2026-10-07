import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Mode from '~/server/services/text-scan/mode';
import type * as Submit from '~/server/services/text-scan/submit';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof Submit>()),
  scanEntity: vi.fn(async () => ({ status: 'submitted', workflowId: 'wf' })),
}));

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof Mode>()),
  isTextScanEnabled: vi.fn(async () => true),
}));

const {
  sweepChatWindows,
  sweepNewUsers,
  TEXT_SCAN_CHAT_CURSOR_KEY,
  TEXT_SCAN_USER_CURSOR_KEY,
  textScanChatWindowsJob,
  textScanNewUsersJob,
} = await import('~/server/jobs/text-scan-sweeps');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { isTextScanEnabled } = await import('~/server/services/text-scan/mode');

const NOW = new Date('2026-09-24T12:00:00Z');
const SETTLED = new Date('2026-09-24T11:50:00Z');
const FRESH = new Date('2026-09-24T11:59:30Z');
const msg = (id: number, chatId: number, userId: number, over: Record<string, unknown> = {}) => ({
  id,
  chatId,
  userId,
  createdAt: SETTLED,
  contentType: 'Markdown',
  deletedAt: null,
  ...over,
});
const cursorAt = (value: number) =>
  dbMock.dbWrite.keyValue.findUnique.mockResolvedValue({ key: 'k', value });
const upserted = (key: string, value: number) =>
  expect(dbMock.dbWrite.keyValue.upsert).toHaveBeenCalledWith({
    where: { key },
    create: { key, value },
    update: { value },
  });
const lastCursor = () => dbMock.dbWrite.keyValue.upsert.mock.calls.at(-1)?.[0].update.value;
const scannedIds = () =>
  vi
    .mocked(scanEntity)
    .mock.calls.map(([a]) => a.entityId)
    .sort((a, b) => a - b);
const eligibleSenders = (...ids: number[]) =>
  dbMock.dbWrite.user.findMany.mockResolvedValue(ids.map((id) => ({ id, isModerator: false })));

beforeEach(() => {
  vi.clearAllMocks();
  eligibleSenders(5, 6);
});

describe('sweepChatWindows', () => {
  it('initialises the cursor at the newest message and scans nothing on its first run', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.chatMessage.findFirst.mockResolvedValue({ id: 500 });
    expect(await sweepChatWindows(NOW)).toMatchObject({ initialised: true, scanned: 0 });
    upserted(TEXT_SCAN_CHAT_CURSOR_KEY, 500);
    expect(dbMock.dbWrite.chatMessage.findMany).not.toHaveBeenCalled();
    expect(scanEntity).not.toHaveBeenCalled();
  });

  it('scans one window per eligible (chat, sender), keyed by the newest message', async () => {
    cursorAt(0);
    dbMock.dbWrite.chatMessage.findMany.mockResolvedValueOnce([
      msg(1, 10, 5),
      msg(2, 10, 6),
      msg(3, 10, 5),
      msg(4, 11, 5),
      msg(5, 10, -1),
      msg(6, 10, 7, { contentType: 'Image' }),
      msg(7, 10, 8, { deletedAt: new Date() }),
      msg(8, 12, 9),
    ]);
    expect(await sweepChatWindows(NOW)).toMatchObject({
      rows: 8,
      scanned: 3,
      submitted: 3,
      caughtUp: true,
    });
    expect(scannedIds()).toEqual([2, 3, 4]);
    expect(vi.mocked(scanEntity).mock.calls.every(([a]) => a.entityType === 'ChatMessage')).toBe(
      true
    );
    upserted(TEXT_SCAN_CHAT_CURSOR_KEY, 8);
  });

  it('reads past the cursor in id order from the primary, with no createdAt filter', async () => {
    cursorAt(40);
    await sweepChatWindows(NOW);
    const { where, orderBy } = dbMock.dbWrite.chatMessage.findMany.mock.calls[0][0];
    expect(where).toEqual({ id: { gt: 40 } });
    expect(orderBy).toEqual({ id: 'asc' });
    expect(dbMock.dbRead.chatMessage.findMany).not.toHaveBeenCalled();
  });

  it('stops at the first unsettled row even when a later row has settled', async () => {
    cursorAt(0);
    dbMock.dbWrite.chatMessage.findMany.mockResolvedValueOnce([
      msg(1, 10, 5),
      msg(2, 10, 6, { createdAt: FRESH }),
      msg(3, 11, 6),
    ]);
    expect(await sweepChatWindows(NOW)).toMatchObject({ rows: 1, caughtUp: true });
    expect(scannedIds()).toEqual([1]);
    expect(lastCursor()).toBe(1);
  });

  it('keeps reading full batches until it catches up', async () => {
    cursorAt(0);
    dbMock.dbWrite.chatMessage.findMany
      .mockResolvedValueOnce([msg(1, 10, 5), msg(2, 11, 5)])
      .mockResolvedValueOnce([msg(3, 12, 5)]);
    expect(await sweepChatWindows(NOW, { batchSize: 2 })).toMatchObject({
      rows: 3,
      caughtUp: true,
    });
    expect(dbMock.dbWrite.chatMessage.findMany.mock.calls[1][0].where).toEqual({ id: { gt: 2 } });
    expect(lastCursor()).toBe(3);
  });

  it('caps the windows scanned per batch and picks up the rest on the next read', async () => {
    cursorAt(0);
    dbMock.dbWrite.chatMessage.findMany
      .mockResolvedValueOnce([msg(1, 10, 5), msg(2, 10, 5), msg(3, 11, 5), msg(4, 12, 6)])
      .mockResolvedValueOnce([msg(4, 12, 6)]);
    expect(await sweepChatWindows(NOW, { maxScansPerBatch: 2 })).toMatchObject({
      rows: 4,
      scanned: 3,
      caughtUp: true,
    });
    expect(
      vi
        .mocked(scanEntity)
        .mock.calls.slice(0, 2)
        .map(([a]) => a.entityId)
    ).toEqual([2, 3]);
    expect(dbMock.dbWrite.chatMessage.findMany.mock.calls[1][0].where).toEqual({ id: { gt: 3 } });
    expect(lastCursor()).toBe(4);
  });

  it('stops at the time budget and logs how far behind it is', async () => {
    cursorAt(0);
    let t = 0;
    let reads = 0;
    // Terminates on its own: a broken deadline then reads 50 batches and fails the count below
    // instead of looping forever.
    dbMock.dbWrite.chatMessage.findMany.mockImplementation(
      async ({ where }: { where: { id: { gt: number } } }) => {
        t += 1000;
        if (++reads > 50) return [];
        return [msg(where.id.gt + 1, 10, 5), msg(where.id.gt + 2, 11, 5)];
      }
    );
    const result = await sweepChatWindows(NOW, { batchSize: 2, budgetMs: 2500, clock: () => t });
    expect(result).toMatchObject({ caughtUp: false, lagMs: NOW.getTime() - SETTLED.getTime() });
    expect(reads).toBe(3);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'text-scan',
        type: 'warning',
        message: 'sweep behind',
        job: 'text-scan-chat-windows',
      })
    );
  });

  it('a full batch whose second row is unsettled is caught up after one read', async () => {
    cursorAt(0);
    let t = 0;
    let reads = 0;
    dbMock.dbWrite.chatMessage.findMany.mockImplementation(async () => {
      t += 1000;
      if (++reads > 50) return [];
      return [msg(1, 10, 5), msg(2, 11, 5, { createdAt: FRESH })];
    });
    const result = await sweepChatWindows(NOW, { batchSize: 2, budgetMs: 60_000, clock: () => t });
    expect(result).toMatchObject({ rows: 1, caughtUp: true });
    expect(reads).toBe(1);
    expect(lastCursor()).toBe(1);
  });

  it('keeps going and still advances when one scan throws', async () => {
    cursorAt(0);
    dbMock.dbWrite.chatMessage.findMany.mockResolvedValueOnce([msg(1, 10, 5), msg(2, 11, 6)]);
    vi.mocked(scanEntity).mockRejectedValueOnce(new Error('flipt down'));
    await sweepChatWindows(NOW);
    expect(scanEntity).toHaveBeenCalledTimes(2);
    upserted(TEXT_SCAN_CHAT_CURSOR_KEY, 2);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'text-scan', type: 'error', message: 'sweep scan threw' })
    );
  });

  it('leaves the cursor alone when nothing is new', async () => {
    cursorAt(9);
    dbMock.dbWrite.chatMessage.findMany.mockResolvedValueOnce([]);
    await sweepChatWindows(NOW);
    expect(dbMock.dbWrite.keyValue.upsert).not.toHaveBeenCalled();
  });
});

describe('sweepNewUsers', () => {
  it('scans the username of each settled, live new account', async () => {
    cursorAt(10);
    dbMock.dbWrite.user.findMany.mockResolvedValueOnce([
      { id: 11, username: 'alice', deletedAt: null, createdAt: SETTLED },
      { id: 12, username: null, deletedAt: null, createdAt: SETTLED },
      { id: 13, username: 'gone', deletedAt: new Date(), createdAt: SETTLED },
      { id: 14, username: 'late', deletedAt: null, createdAt: FRESH },
    ]);
    expect(await sweepNewUsers(NOW)).toMatchObject({ rows: 3, scanned: 1 });
    expect(scanEntity).toHaveBeenCalledWith({ entityType: 'User', entityId: 11 });
    upserted(TEXT_SCAN_USER_CURSOR_KEY, 13);
  });

  it('caps the usernames scanned per batch', async () => {
    cursorAt(10);
    dbMock.dbWrite.user.findMany
      .mockResolvedValueOnce([
        { id: 11, username: 'a', deletedAt: null, createdAt: SETTLED },
        { id: 12, username: 'b', deletedAt: null, createdAt: SETTLED },
      ])
      .mockResolvedValueOnce([{ id: 12, username: 'b', deletedAt: null, createdAt: SETTLED }]);
    expect(await sweepNewUsers(NOW, { maxScansPerBatch: 1 })).toMatchObject({
      rows: 2,
      caughtUp: true,
    });
    expect(dbMock.dbWrite.user.findMany.mock.calls[1][0].where).toEqual({ id: { gt: 11 } });
  });

  it('initialises at the newest user on its first run', async () => {
    dbMock.dbWrite.keyValue.findUnique.mockResolvedValue(null);
    dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: 900 });
    expect(await sweepNewUsers(NOW)).toMatchObject({ initialised: true });
    upserted(TEXT_SCAN_USER_CURSOR_KEY, 900);
    expect(scanEntity).not.toHaveBeenCalled();
  });
});

describe('kill switch', () => {
  it.each([
    ['chat', () => sweepChatWindows(NOW), TEXT_SCAN_CHAT_CURSOR_KEY],
    ['new users', () => sweepNewUsers(NOW), TEXT_SCAN_USER_CURSOR_KEY],
  ] as const)(
    '%s: off reads no rows, scans nothing, and moves the cursor to the newest row',
    async (_n, run, key) => {
      vi.mocked(isTextScanEnabled).mockResolvedValueOnce(false);
      cursorAt(10);
      dbMock.dbWrite.chatMessage.findFirst.mockResolvedValue({ id: 500 } as never);
      dbMock.dbWrite.user.findFirst.mockResolvedValue({ id: 500 } as never);
      expect(await run()).toMatchObject({ disabled: true, scanned: 0 });
      upserted(key, 500);
      expect(dbMock.dbWrite.chatMessage.findMany).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.user.findMany).not.toHaveBeenCalled();
      expect(scanEntity).not.toHaveBeenCalled();
    }
  );
});

describe('scheduling', () => {
  it('runs both sweeps every 5 minutes from the jobs array', () => {
    expect(textScanChatWindowsJob.cron).toBe('*/5 * * * *');
    expect(textScanNewUsersJob.cron).toBe('*/5 * * * *');
    const route = readFileSync(
      path.resolve(__dirname, '../../../pages/api/webhooks/run-jobs/[[...run]].ts'),
      'utf8'
    );
    const start = route.indexOf('export const jobs: Job[] = [');
    const array = route.slice(start, route.indexOf('];', start));
    expect(array).toContain('textScanChatWindowsJob');
    expect(array).toContain('textScanNewUsersJob');
  });
});
