import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `/api/mod/user/creator-program-ban`: who may call it, the schema bounds, and that the actor is the
 * session's moderator. The bit arithmetic and the audit row are pinned against Postgres in
 * `creator-program-ban.service.test.ts`.
 */

const { mockAudit, session, setBan, hasModeratorGrant } = vi.hoisted(() => ({
  mockAudit: vi.fn(),
  session: { user: {} as Record<string, unknown> },
  setBan: vi.fn<(...a: unknown[]) => Promise<Record<string, unknown>>>(async () => ({
    userId: 8675309,
    action: 'set',
    before: 15,
    after: 47,
    changed: true,
  })),
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
}));

vi.mock('~/server/auth/bearer-token', () => ({
  getSessionFromBearerToken: vi.fn(async () => null),
}));
vi.mock('~/server/auth/get-server-auth-session', () => ({
  getServerAuthSession: vi.fn(async () => session),
}));
vi.mock('~/server/clickhouse/client', () => ({
  Tracker: class {
    retoolAudit = mockAudit;
  },
}));
vi.mock('@civitai/next-axiom', () => ({ withAxiom: (fn: unknown) => fn }));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  handleEndpointError: (
    res: { status: (n: number) => { json: (b: unknown) => unknown } },
    e: unknown
  ) => {
    const status = e instanceof TRPCError ? getHTTPStatusCodeFromError(e) : 500;
    return res
      .status(status)
      .json({ error: (e as { code?: string }).code ?? 'error', message: (e as Error).message });
  },
}));
// The limits are restated rather than imported so the bounds below are pinned to these numbers.
vi.mock('~/server/services/creator-program-ban.service', () => ({
  CREATOR_PROGRAM_BAN_REASON_MAX: 500,
  CREATOR_PROGRAM_BAN_GATE_REF_MAX: 200,
  setCreatorProgramBan: (...a: unknown[]) => setBan(...a),
}));
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

import handler from '~/pages/api/mod/user/creator-program-ban';

const MODERATOR = 990000007;
const TARGET = 8675309;
const BAN = { userId: TARGET, action: 'set', reason: 'Counterparty farming' };

function call(body: Record<string, unknown>, method = 'POST') {
  const req = { method, headers: {}, body, query: {} } as Parameters<typeof handler>[0];
  let statusCode = 200;
  let payload: unknown;
  const res = {
    status(c: number) {
      statusCode = c;
      return res;
    },
    json(b: unknown) {
      payload = b;
      return res;
    },
    setHeader: vi.fn(),
    end() {
      return res;
    },
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  session.user = { id: MODERATOR, isModerator: true, permissions: [], bannedAt: null };
  hasModeratorGrant.mockResolvedValue(true);
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('who may call it', () => {
  it('refuses a signed-in non-moderator', async () => {
    session.user = { id: 990000099, isModerator: false, permissions: [], bannedAt: null };
    const { status } = await call(BAN);
    expect(status).toBe(403);
    expect(setBan).not.toHaveBeenCalled();
  });

  it('refuses a moderator without the user.creatorProgram.ban permission', async () => {
    hasModeratorGrant.mockResolvedValue(false);
    const { status, body } = await call(BAN);
    expect(status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: MODERATOR }),
      'user.creatorProgram.ban'
    );
    expect(body).toMatchObject({ message: expect.stringContaining('user.creatorProgram.ban') });
    expect(setBan).not.toHaveBeenCalled();
  });

  it('control: a holder of the permission bans, and gets before/after back', async () => {
    const { status, body } = await call(BAN);
    expect(status).toBe(200);
    expect(body).toEqual({ userId: TARGET, action: 'set', before: 15, after: 47, changed: true });
  });

  it('refuses GET (a mutating GET would be forgeable cross-site)', async () => {
    const { status } = await call(BAN, 'GET');
    expect(status).toBe(405);
    expect(setBan).not.toHaveBeenCalled();
  });
});

describe('the actor is the session, not the body', () => {
  it('passes the acting moderator id and the gateRef, ignoring a moderatorId in the body', async () => {
    await call({ ...BAN, action: 'clear', gateRef: 'hub:request:abc', moderatorId: 1 });
    expect(setBan).toHaveBeenCalledWith({
      userId: TARGET,
      action: 'clear',
      reason: 'Counterparty farming',
      gateRef: 'hub:request:abc',
      moderatorId: MODERATOR,
    });
  });

  it('records the target account on the request audit row', async () => {
    await call(BAN);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.creator-program-ban',
        outcome: 'ok',
        affected: { userIds: [TARGET] },
      })
    );
  });
});

describe('schema bounds', () => {
  it.each([
    ['no reason', { reason: undefined }],
    ['a blank reason', { reason: '   ' }],
    ['a 501-char reason', { reason: 'x'.repeat(501) }],
    ['an unknown action', { action: 'toggle' }],
    ['no action', { action: undefined }],
    ['no userId', { userId: undefined }],
    ['a blank gateRef', { gateRef: ' ' }],
    ['a 201-char gateRef', { gateRef: 'x'.repeat(201) }],
  ])('refuses %s with a 400 and changes nothing', async (_label, patch) => {
    const { status } = await call({ ...BAN, ...patch });
    expect(status).toBe(400);
    expect(setBan).not.toHaveBeenCalled();
  });

  it.each([
    ['a 500-char reason', { reason: 'x'.repeat(500) }],
    ['clear', { action: 'clear' }],
    ['a gateRef', { gateRef: 'hub:request:abc' }],
  ])('control: accepts %s', async (_label, patch) => {
    const { status } = await call({ ...BAN, ...patch });
    expect(status).toBe(200);
    expect(setBan).toHaveBeenCalledTimes(1);
  });
});
