import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const { session, hasModeratorGrant } = vi.hoisted(() => ({
  session: { user: { id: 7, isModerator: true, permissions: [], bannedAt: null, roles: [] } },
  hasModeratorGrant: vi.fn<(...a: unknown[]) => Promise<boolean>>(),
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
vi.mock('~/server/services/moderator-grants', () => ({
  hasModeratorGrant: (...a: unknown[]) => hasModeratorGrant(...a),
}));

const updateMany = dbMock.dbWrite.textScanHold.updateMany;
const findUnique = dbMock.dbWrite.textScanHold.findUnique;

import handler from '~/pages/api/mod/text-scan/csam-hold/resolve';

function call(body: Record<string, unknown>) {
  const req = { method: 'POST', headers: {}, body, query: {} } as Parameters<typeof handler>[0];
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
    end: () => res,
  } as unknown as Parameters<typeof handler>[1];
  return handler(req, res).then(() => ({ status: statusCode, body: payload }));
}

beforeEach(() => {
  vi.clearAllMocks();
  hasModeratorGrant.mockResolvedValue(true);
  updateMany.mockResolvedValue({ count: 1 });
  findUnique.mockResolvedValue({ entityType: 'ChatMessage', entityId: 55 });
  redisMock.sysRedis.multi.mockImplementation(() => ({
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue(['OK', 1]),
  }));
  redisMock.sysRedis.ttl.mockResolvedValue(60);
});

describe('textScan.resolveCsamHold', () => {
  it('dismisses a pending csam hold as the acting moderator', async () => {
    const { status, body } = await call({ holdId: 12, decision: 'dismiss', note: 'fine' });
    expect(status).toBe(200);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 12, label: 'csam', status: 'Pending' },
      data: {
        status: 'Dismissed',
        decidedAt: expect.any(Date),
        decidedById: 7,
        decisionNote: 'fine',
      },
    });
    expect(body).toMatchObject({ holdId: 12, status: 'Dismissed' });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'csam-hold-decision',
        holdId: 12,
        entityType: 'ChatMessage',
        entityId: 55,
        decision: 'dismiss',
        moderatorId: 7,
      })
    );
  });

  it('records a dismissal without a note as no note', async () => {
    await call({ holdId: 12, decision: 'dismiss', note: '  ' });
    expect(updateMany.mock.calls[0][0].data.decisionNote).toBeNull();
  });

  it('refuses a moderator without the csam permission', async () => {
    hasModeratorGrant.mockResolvedValue(false);
    expect((await call({ holdId: 12, decision: 'dismiss' })).status).toBe(403);
    expect(hasModeratorGrant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7 }),
      'csam.report.file'
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('answers 409 when the hold is already decided or missing', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    expect((await call({ holdId: 12, decision: 'dismiss' })).status).toBe(409);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'csam-hold-decision' })
    );
  });

  it.each([
    ['a confirm, which is not offered yet', { holdId: 12, decision: 'confirm' }],
    ['no hold id', { decision: 'dismiss' }],
    ['a note over the limit', { holdId: 12, decision: 'dismiss', note: 'x'.repeat(501) }],
  ])('refuses %s before writing', async (_, body) => {
    expect((await call(body)).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
