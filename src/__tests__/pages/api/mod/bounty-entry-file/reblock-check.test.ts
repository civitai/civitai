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

import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import handler from '~/pages/api/mod/bounty-entry-file/reblock-check';

/**
 * Who may re-block and what the request must carry. What the re-block writes is covered against a
 * real Postgres in bounty-entry-file-check.reblock.behavior.test.ts.
 */

const FILE_ID = 31;
const ENTRY_ID = 20;
const CLEARED = {
  hashCheckedAt: '2026-10-20T00:00:00Z',
  blockedReason: 'other-users-model',
  checkOverride: { by: 1, at: '2026-10-21T00:00:00Z', reason: 'their own alt account' },
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

const tx = { $executeRaw: vi.fn(), $queryRaw: vi.fn() };
const anyWrite = () =>
  tx.$executeRaw.mock.calls.length +
  tx.$queryRaw.mock.calls.length +
  dbMock.dbWrite.$executeRaw.mock.calls.length;

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
    url: 'https://storage.example.com/u/31',
    entityType: 'BountyEntry',
    entityId: ENTRY_ID,
    metadata: CLEARED,
  } as never);
  tx.$executeRaw.mockResolvedValue(1);
  tx.$queryRaw.mockResolvedValue([{ metadata: { ...CLEARED, checkOverride: undefined } }]);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (client: unknown) => unknown) =>
    fn(tx)) as never);
});

describe('bountyEntryFile.reblockCheck', () => {
  it('re-blocks a cleared file for a moderator, with the trimmed reason in the ModActivity row', async () => {
    expect(await call({ fileId: FILE_ID, reason: '  the alt claim did not hold up ' })).toBe(200);
    const activity = tx.$executeRaw.mock.calls
      .map((c) => c.slice(1))
      .find((values) => String(values[2]).startsWith('reblockFileCheck:'));
    expect(activity).toEqual([
      7,
      'bountyEntry',
      `reblockFileCheck:${JSON.stringify({
        fileId: FILE_ID,
        reason: 'the alt claim did not hold up',
      })}`,
      [ENTRY_ID],
    ]);
  });

  it('refuses a caller who is not signed in, and changes nothing', async () => {
    vi.mocked(getServerAuthSession).mockResolvedValueOnce(null);
    expect(await call({ fileId: FILE_ID, reason: 'the alt claim did not hold up' })).toBe(401);
    expect(dbMock.dbWrite.file.findUnique).not.toHaveBeenCalled();
    expect(anyWrite()).toBe(0);
  });

  it('refuses a caller who is not a moderator, and changes nothing', async () => {
    session.user.isModerator = false;
    expect(await call({ fileId: FILE_ID, reason: 'the alt claim did not hold up' })).toBe(403);
    expect(dbMock.dbWrite.file.findUnique).not.toHaveBeenCalled();
    expect(anyWrite()).toBe(0);
  });

  it.each([
    ['a missing reason', { fileId: FILE_ID }],
    ['a reason that is only whitespace', { fileId: FILE_ID, reason: ' \n\t ' }],
  ])('refuses %s', async (_, body) => {
    expect(await call(body)).toBe(400);
    expect(anyWrite()).toBe(0);
  });
});
