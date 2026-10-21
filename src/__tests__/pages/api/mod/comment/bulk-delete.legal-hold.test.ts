import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `comment.bulkDelete` sums the comments both tables kept, and a hold abort reaches the moderator as
 * the neutral stopped message, never as the database error (which names the marker view). Drives the
 * real endpoint through its real wrapper; the services are stubbed.
 */

const { mockGetSession, v1, v2 } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  v1: vi.fn(),
  v2: vi.fn(),
}));

vi.mock('~/server/auth/bearer-token', () => ({ getSessionFromBearerToken: mockGetSession }));
vi.mock('~/server/auth/get-server-auth-session', () => ({ getServerAuthSession: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = vi.fn();
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/services/comment.service', () => ({ bulkDeleteComments: v1 }));
vi.mock('~/server/services/commentsv2.service', () => ({ bulkDeleteCommentsV2: v2 }));

import handler from '~/pages/api/mod/comment/bulk-delete';
import { LEGAL_HOLD_STOPPED } from '~/server/services/legal-hold.service';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

redisMock.sysRedis.multi.mockImplementation(() => ({
  set: vi.fn().mockReturnThis(),
  incr: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue(['OK', 1]),
}));
redisMock.sysRedis.ttl.mockResolvedValue(60);

async function call() {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer tok' },
    body: { commentIds: [1, 2], commentV2Ids: [3] },
    query: {},
    socket: {},
  } as unknown as Parameters<typeof handler>[0];
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
    setHeader: vi.fn(),
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  await handler(req, res);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockGetSession.mockResolvedValue({
    user: { id: 7, isModerator: true, bannedAt: null, permissions: [] },
    apiKeyId: 1,
    apiKeyType: 'User',
    subject: { type: 'apiKey', id: 1 },
    tokenScope: TokenScope.Full,
  });
  v1.mockResolvedValue({ count: 1, retainedHidden: 1 });
  v2.mockResolvedValue({ count: 0, retainedHidden: 1 });
});

describe('comment.bulkDelete', () => {
  it('returns what each table deleted and what both kept hidden', async () => {
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body).toMatchObject({ commentDeleted: 1, commentV2Deleted: 0, retainedHidden: 2 });
  });

  it('answers a hold abort with the neutral stopped message', async () => {
    v2.mockRejectedValue(new Error('relation "EvidenceHeldUser" does not exist'));

    const { status, body } = await call();

    expect(status).toBe(409);
    expect(JSON.stringify(body)).toContain(LEGAL_HOLD_STOPPED);
    expect(JSON.stringify(body)).not.toContain('EvidenceHeldUser');
  });
});
