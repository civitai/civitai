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

/** Every UPDATE on "File" the call ran. */
const fileUpdates = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.filter((c: unknown[]) =>
    (c[0] as string[]).join('?').includes('UPDATE "File"')
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
  dbMock.dbWrite.$executeRaw.mockResolvedValue(1 as never);
});

describe('bountyEntryFile.clearCheck', () => {
  it('records the clear on the file as reviewed, with who and why, and logs it', async () => {
    expect(await call({ fileId: FILE_ID, reason: '  their own alt account ' })).toBe(200);

    const [update] = fileUpdates();
    const [strings, ...values] = update as [string[], ...unknown[]];
    // Guarded on the url the moderator saw and on the file still being blocked.
    const sql = strings.join('?').replace(/\s+/g, ' ');
    expect(sql).toContain(`WHERE id = ? AND url = ? AND "entityType" = 'BountyEntry'`);
    expect(sql).toContain(
      `AND metadata->>'blockedReason' IS NOT NULL AND metadata->'checkOverride' IS NULL`
    );
    expect(values.slice(1, 3)).toEqual([FILE_ID, URL]);
    const override = JSON.parse(values[0] as string);
    expect(override).toEqual({ by: 7, at: expect.any(String), reason: 'their own alt account' });
    expect(fileCheckState({ ...BLOCKED, checkOverride: override })).toBe('clean');

    const modActivity = dbMock.dbWrite.$executeRaw.mock.calls.find((c: unknown[]) =>
      (c[0] as string[]).join('?').includes('"ModActivity"')
    );
    expect(modActivity?.slice(1)).toEqual([7, 'bountyEntry', 'clearFileCheck', [ENTRY_ID]]);
  });

  it('refuses a caller who is not a moderator, and changes nothing', async () => {
    session.user.isModerator = false;
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(403);
    expect(dbMock.dbWrite.file.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses a missing reason', async () => {
    expect(await call({ fileId: FILE_ID })).toBe(400);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses a reason that is only whitespace', async () => {
    expect(await call({ fileId: FILE_ID, reason: ' \n\t ' })).toBe(400);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
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
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when the file changed between the read and the write, and logs nothing', async () => {
    dbMock.dbWrite.$executeRaw.mockResolvedValue(0 as never);
    expect(await call({ fileId: FILE_ID, reason: 'their own alt account' })).toBe(400);
    expect(fileUpdates()).toHaveLength(1);
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(1);
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
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
