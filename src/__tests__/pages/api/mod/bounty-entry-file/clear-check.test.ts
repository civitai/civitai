import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { session } = vi.hoisted(() => ({
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null } },
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: vi.fn() }));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
    userActivity = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));

import handler from '~/pages/api/mod/bounty-entry-file/clear-check';
import { fileCheckState } from '~/server/services/bounty-entry-file-check.service';

const FILE_ID = 31;
const ENTRY_ID = 20;
const URL = 'https://storage.example.com/u/31';
const BLOCKED = {
  hashCheckedAt: '2026-10-20T00:00:00Z',
  sha256Server: 'F'.repeat(64),
  blockedReason: 'other-users-model',
};

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json: () => res,
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => statusCode);
}

/** The transaction client the clear writes through, distinct from `dbWrite` itself. */
const tx = { $executeRaw: vi.fn() };
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?').replace(/\s+/g, ' ');
const fileUpdates = () =>
  tx.$executeRaw.mock.calls.filter((c) => sqlOf(c).includes('UPDATE "File"'));
const modActivityRows = () =>
  tx.$executeRaw.mock.calls.filter((c) => sqlOf(c).includes('"ModActivity"'));
const anyWrite = () =>
  tx.$executeRaw.mock.calls.length + dbMock.dbWrite.$executeRaw.mock.calls.length;
const loggedClear = () =>
  loggingMock.logToAxiom.mock.calls.some(
    ([e]) => (e as { message?: string }).message === 'override cleared'
  );

loggingMock.logToAxiom.mockImplementation(() => Promise.resolve());

beforeEach(() => {
  vi.clearAllMocks();
  session.user.isModerator = true;
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
  dbMock.dbWrite.file.findUnique.mockResolvedValue({
    id: FILE_ID,
    url: URL,
    entityType: 'BountyEntry',
    entityId: ENTRY_ID,
    metadata: BLOCKED,
  } as never);
  tx.$executeRaw.mockResolvedValue(1);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (client: unknown) => unknown) =>
    fn(tx)) as never);
});

describe('bountyEntryFile.clearCheck', () => {
  it('records the clear on the file as reviewed, with who and why, and logs it', async () => {
    expect(await call({ fileId: FILE_ID, reason: '  their own alt account ' })).toBe(200);

    const [update] = fileUpdates();
    const [, ...values] = update as [string[], ...unknown[]];
    // Guarded on the url the moderator saw and on the file still being blocked.
    expect(sqlOf(update)).toContain(
      `WHERE f.id = ? AND f.url = ? AND f."entityType" = 'BountyEntry' AND f.metadata->>'blockedReason' IS NOT NULL AND f.metadata->'checkOverride' IS NOT DISTINCT FROM ?::jsonb`
    );
    // No stored clear was read, so the write requires there still to be none.
    expect(values.slice(1, 4)).toEqual([FILE_ID, URL, null]);
    const override = JSON.parse(values[0] as string);
    expect(override).toEqual({ by: 7, at: expect.any(String), reason: 'their own alt account' });
    expect(fileCheckState({ ...BLOCKED, checkOverride: override })).toBe('clean');

    // One row per clear, carrying the reason, so it outlives the file's copy.
    expect(modActivityRows().map((c) => c.slice(1))).toEqual([
      [
        7,
        'bountyEntry',
        `clearFileCheck:${JSON.stringify({ fileId: FILE_ID, reason: 'their own alt account' })}`,
        [ENTRY_ID],
      ],
    ]);
    // Both writes ride the transaction; nothing goes to the bare client.
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(loggedClear()).toBe(true);
  });

  it('fails the clear when its ModActivity row cannot be written, so the transaction rolls back', async () => {
    tx.$executeRaw.mockImplementation(async (strings: string[]) => {
      if (strings.join('').includes('"ModActivity"')) throw new Error('insert failed');
      return 1;
    });
    const settled: Promise<unknown>[] = [];
    dbMock.dbWrite.$transaction.mockImplementation(((fn: (client: unknown) => unknown) => {
      const run = Promise.resolve().then(() => fn(tx));
      settled.push(run.catch((e) => e));
      return run;
    }) as never);

    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(500);
    // The UPDATE ran inside the transaction, and the transaction itself failed: Prisma rolls it back.
    expect(fileUpdates()).toHaveLength(1);
    expect(await Promise.all(settled)).toEqual([new Error('insert failed')]);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(loggedClear()).toBe(false);
  });

  it('refuses a caller who is not a moderator, and changes nothing', async () => {
    session.user.isModerator = false;
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(403);
    expect(dbMock.dbWrite.file.findUnique).not.toHaveBeenCalled();
    expect(anyWrite()).toBe(0);
  });

  it('refuses a missing reason', async () => {
    expect(await call({ fileId: FILE_ID })).toBe(400);
    expect(anyWrite()).toBe(0);
  });

  it('refuses a reason that is only whitespace', async () => {
    expect(await call({ fileId: FILE_ID, reason: ' \n\t ' })).toBe(400);
    expect(anyWrite()).toBe(0);
  });

  it.each([
    ['clean', { hashCheckedAt: '2026-10-20T00:00:00Z' }],
    ['already cleared', { ...BLOCKED, checkOverride: { by: 1, at: 'x', reason: 'r' } }],
    ['not checked yet', {}],
  ])('refuses a file that is no longer blocked (%s)', async (_, metadata) => {
    dbMock.dbWrite.file.findUnique.mockResolvedValue({
      id: FILE_ID,
      url: URL,
      entityType: 'BountyEntry',
      entityId: ENTRY_ID,
      metadata,
    } as never);
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(400);
    expect(anyWrite()).toBe(0);
  });

  it('clears over a malformed stored clear, guarded on the exact value it read', async () => {
    const planted = { by: '7', at: 'x', reason: 'planted' };
    dbMock.dbWrite.file.findUnique.mockResolvedValue({
      id: FILE_ID,
      url: URL,
      entityType: 'BountyEntry',
      entityId: ENTRY_ID,
      metadata: { ...BLOCKED, checkOverride: planted },
    } as never);
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(200);
    const [update] = fileUpdates();
    expect(JSON.parse(update[4] as string)).toEqual(planted);
  });

  it('refuses when the file changed between the read and the write, and logs nothing', async () => {
    tx.$executeRaw.mockResolvedValue(0);
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(400);
    expect(fileUpdates()).toHaveLength(1);
    expect(modActivityRows()).toHaveLength(0);
    expect(loggedClear()).toBe(false);
  });

  it('refuses a file that is not a bounty entry file', async () => {
    dbMock.dbWrite.file.findUnique.mockResolvedValue({
      id: FILE_ID,
      url: URL,
      entityType: 'Article',
      entityId: 4,
      metadata: BLOCKED,
    } as never);
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(404);
    expect(anyWrite()).toBe(0);
  });
});
