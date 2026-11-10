import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModerationService from '~/server/services/commentv3/moderation.service';

// What a moderator client reads back from comment.bulkDelete and comment.restoreFromTos, and the ids
// the audit trail records. Lives outside src/pages: see remove-as-tos.client-ip.test.ts.

const { mockGetSession, mockRetoolAudit, bulkDelete, clearTos } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRetoolAudit: vi.fn(),
  bulkDelete: vi.fn(),
  clearTos: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockRetoolAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/commentv3/moderation.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationService>()),
  bulkDeleteComments: bulkDelete,
  bulkClearCommentV3TosViolation: clearTos,
}));

import bulkDeleteHandler from '~/pages/api/mod/comment/bulk-delete';
import restoreHandler from '~/pages/api/mod/comment/restore-from-tos';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

redisMock.sysRedis.multi.mockImplementation(() => ({
  set: vi.fn().mockReturnThis(),
  incr: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(['OK', 1]),
}));
redisMock.sysRedis.ttl.mockResolvedValue(60);

type Handler = typeof bulkDeleteHandler;
async function call(handler: Handler, commentIds: number[]) {
  let status = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      status = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  };
  await handler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
      body: { commentIds },
      query: {},
      socket: {},
    } as never,
    res as never
  );
  return { status, payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue({
    user: { id: 7, isModerator: true, bannedAt: null, permissions: [] },
    apiKeyId: 1,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 1 },
    tokenScope: TokenScope.Full,
  });
});

describe('comment.bulkDelete', () => {
  it('deletes the ids it was sent, answers { deleted }, and audits the ids', async () => {
    bulkDelete.mockResolvedValue({ deleted: 2 });
    expect(await call(bulkDeleteHandler, [4, 5])).toEqual({ status: 200, payload: { deleted: 2 } });
    expect(bulkDelete).toHaveBeenCalledWith({ ids: [4, 5] });
    expect(mockRetoolAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'ok', affected: { commentIds: [4, 5] } })
    );
  });
});

describe('comment.restoreFromTos', () => {
  it('clears the ids it was sent, answers { comments }, and audits the ids', async () => {
    const comments = { count: 2, reopenedReports: 1, failed: 0 };
    clearTos.mockResolvedValue(comments);
    expect(await call(restoreHandler, [4, 5])).toEqual({ status: 200, payload: { comments } });
    expect(clearTos).toHaveBeenCalledWith({ ids: [4, 5] });
    expect(mockRetoolAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'ok', affected: { commentIds: [4, 5] } })
    );
  });
});
